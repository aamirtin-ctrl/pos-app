// ALL ipcMain handlers — the single typed boundary between renderer and main.
// Channel names mirror the window.pos.* surface in renderer/src/pos.d.ts.

import { ipcMain, shell, dialog, BrowserWindow } from "electron";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting, hasVec } from "./db/db.ts";
import { SecretStore, SECRET_NAMES } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import { monthSpend, getCeiling, setCeiling } from "./llm/meter.ts";
import { listPeople, getPerson, patchPerson, mergePeople } from "./crm/people.ts";
import { rank } from "./crm/ranking.ts";
import { reconnectDue, refreshNextTouch } from "./crm/reconnect.ts";
import { listCommitments, confirmCommitment, dropCommitment } from "./crm/commitments.ts";
import { embedProfiles, makeQueryEmbedder } from "./llm/embeddings.ts";
import * as planner from "./planner.ts";
import { handleCommand } from "./assistant.ts";
import { transcribe } from "./stt.ts";
import { generateDrafts, listDrafts, setDraftStatus, synthesizeVoices, getVoices } from "./crm/drafts.ts";
import { captureOutcomes, adherenceStats, applyLearning } from "./engine/learning.ts";
import { runSync, syncStatus } from "./workers.ts";
import { listMailAccounts, addMailAccount, removeMailAccount, type MailProvider } from "./connectors/gmail.ts";
import { saveDoctrine } from "./engine/doctrine.ts";
import { runLoopbackAuth, cancelLoopbackAuth, isGoogleConnected, hasGoogleCreds } from "./gcal/auth.ts";
import { pushPlan, pushTasks, reconcileMovedEvents, readAnchors } from "./gcal/sync.ts";
import fs from "node:fs";
import path from "node:path";

export interface IpcDeps {
  db: Db;
  secrets: SecretStore;
  doctrineDir: string;
  llm: () => LlmClient | null; // re-evaluated per call so newly-entered keys take effect
}

export function registerIpc(deps: IpcDeps) {
  const { db, secrets, doctrineDir } = deps;
  const h = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        console.error(`ipc ${channel}:`, err);
        return { ok: false, error: (err as Error).message };
      }
    });

  // ── people / relationships ──
  h("people.list", (q?: string) => listPeople(db, q));
  h("people.get", (id: number) => getPerson(db, id));
  h("people.patch", (id: number, fields: Record<string, unknown>) => patchPerson(db, id, fields));
  h("people.merge", (ids: number[]) => mergePeople(db, ids));
  h("people.reconnect", () => {
    refreshNextTouch(db);
    return reconnectDue(db);
  });
  h("query.rank", async (inquiry: string) =>
    rank(db, deps.llm(), inquiry, { embedQuery: (hasVec() && makeQueryEmbedder(db, secrets)) || undefined })
  );

  // ── groups / tags (sidecars) ──
  h("groups.list", () =>
    db.prepare(
      `SELECT g.*, COUNT(pg.person_id) AS members FROM grp g
       LEFT JOIN person_group pg ON pg.group_id = g.id GROUP BY g.id ORDER BY g.name`
    ).all()
  );
  h("groups.create", (name: string) => db.prepare("INSERT OR IGNORE INTO grp (name) VALUES (?)").run(name));
  h("groups.assign", (personId: number, name: string) => {
    db.prepare("INSERT OR IGNORE INTO grp (name) VALUES (?)").run(name);
    const g = db.prepare("SELECT id FROM grp WHERE name = ?").get(name) as { id: number };
    return db.prepare("INSERT OR IGNORE INTO person_group (person_id, group_id) VALUES (?, ?)").run(personId, g.id);
  });
  h("groups.remove", (personId: number, name: string) =>
    db.prepare(
      "DELETE FROM person_group WHERE person_id = ? AND group_id = (SELECT id FROM grp WHERE name = ?)"
    ).run(personId, name)
  );
  h("groups.hide", (name: string, hidden: boolean) =>
    db.prepare("UPDATE grp SET hidden = ? WHERE name = ?").run(hidden ? 1 : 0, name)
  );

  // ── commitments ──
  h("commitments.list", (status?: string) => listCommitments(db, status));
  h("commitments.confirm", (id: number) => confirmCommitment(db, id));
  h("commitments.drop", (id: number) => dropCommitment(db, id));
  // right-click → schedule: commitment becomes a task on today's plan date
  h("commitments.schedule", (id: number) => {
    const c = db.prepare("SELECT id, description, due_at FROM commitment WHERE id = ?").get(id) as
      | { id: number; description: string; due_at: string | null } | undefined;
    if (!c) throw new Error("commitment not found");
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO task (title, block_type, cognitive_load, estimated_minutes, raw_estimate_minutes,
        commitment_id, status, plan_date, hard_deadline_at, estimate_source)
       VALUES (?, 'admin', 2, 30, 30, ?, 'inbox', ?, ?, 'inferred')`
    ).run(c.description.slice(0, 120), c.id, today, c.due_at);
    db.prepare("UPDATE commitment SET status = 'scheduled' WHERE id = ?").run(id);
    return { scheduled: true };
  });

  // ── planner ──
  h("tasks.braindump", (text: string, dateISO: string) =>
    planner.braindump(db, doctrineDir, deps.llm(), text, dateISO)
  );
  h("tasks.list", (dateISO: string) => planner.listTasks(db, dateISO));
  h("tasks.setStatus", (id: number, status: string) =>
    db.prepare(
      "UPDATE task SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE completed_at END WHERE id = ?"
    ).run(status, status, id)
  );
  h("plan.generate", (dateISO: string) => planner.generatePlan(db, doctrineDir, secrets, deps.llm(), dateISO));
  h("plan.get", (dateISO: string) => planner.getPlan(db, dateISO));
  h("plan.accept", (planId: number) => planner.acceptPlan(db, planId));
  h("plan.push", async (planId: number) => {
    const cal = await pushPlan(db, secrets, planId);
    const tasks = await pushTasks(db, secrets);
    return { ...cal, ...tasks };
  });

  // ── outcomes / learning ──
  h("outcomes.needed", (dateISO: string) => planner.outcomesNeeded(db, dateISO));
  h("outcomes.capture", (entries: Parameters<typeof captureOutcomes>[1]) => {
    const n = captureOutcomes(db, entries);
    const file = path.join(doctrineDir, "doctrine.yaml");
    const { yaml, changed } = applyLearning(fs.readFileSync(file, "utf8"), db);
    if (changed) fs.writeFileSync(file, yaml, "utf8");
    return { captured: n, doctrineUpdated: changed };
  });
  h("outcomes.adherence", () => adherenceStats(db));

  // ── sync / integrations ──
  h("sync.run", (source: string, extra?: string) => runSync(db, secrets, deps.llm(), source, extra));
  // File-based imports: pick the LinkedIn export folder / a .mbox|.eml file, then sync.
  h("sync.pickAndRun", async (source: "linkedin" | "mailfile") => {
    const res = await dialog.showOpenDialog({
      title: source === "linkedin" ? "Select your LinkedIn data-export folder" : "Select a .mbox or .eml export",
      properties: source === "linkedin" ? ["openDirectory"] : ["openFile"],
      ...(source === "mailfile" ? { filters: [{ name: "Mail exports", extensions: ["mbox", "eml"] }] } : {}),
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true };
    return runSync(db, secrets, deps.llm(), source, res.filePaths[0]);
  });
  h("sync.status", () => syncStatus(db));
  // Mail accounts (multi-account IMAP). list NEVER returns passwords.
  h("mail.accounts.list", () =>
    listMailAccounts(secrets).map(({ id, provider, user, host }) => ({ id, provider, user, host }))
  );
  h("mail.accounts.add", (acct: { provider: MailProvider; user: string; password: string; host?: string; port?: number }) => {
    const a = addMailAccount(secrets, acct);
    return { id: a.id, provider: a.provider, user: a.user, host: a.host };
  });
  h("mail.accounts.remove", (id: string) => {
    removeMailAccount(secrets, id);
    return { removed: true };
  });
  h("sync.embed", () => embedProfiles(db, secrets));

  // ── google ──
  h("gcal.connect", () => runLoopbackAuth(secrets, (url) => shell.openExternal(url)));
  h("gcal.cancel", () => {
    cancelLoopbackAuth();
    return { canceled: true };
  });
  h("gcal.connected", () => ({ connected: isGoogleConnected(secrets), hasCreds: hasGoogleCreds(secrets) }));
  h("gcal.reconcile", () => reconcileMovedEvents(db, secrets));
  h("gcal.events", (dateISO: string) => readAnchors(db, secrets, dateISO));

  // ── messaging drafts + voices ──
  h("drafts.list", () => listDrafts(db));
  h("drafts.generate", () => generateDrafts(db, deps.llm()));
  h("drafts.setStatus", (id: number, status: "dismissed" | "sent") => setDraftStatus(db, id, status));
  h("voice.synthesize", () => synthesizeVoices(db, deps.llm()));
  h("voice.get", () => getVoices(db));

  // ── unified assistant ──
  h("assistant.command", (text: string) =>
    handleCommand({ db, secrets, doctrineDir, llm: deps.llm() }, text)
  );

  // ── settings ──
  h("settings.keys", () => {
    const set = new Set(secrets.list().map((s) => s.name));
    return SECRET_NAMES.map((n) => ({ name: n, present: set.has(n) }));
  });
  h("settings.setKey", (name: string, value: string) => {
    if (value) secrets.set(name, value);
    else secrets.delete(name);
    return { saved: true };
  });
  h("settings.doctrine.get", () => fs.readFileSync(path.join(doctrineDir, "doctrine.yaml"), "utf8"));
  h("settings.doctrine.set", (yamlText: string) => {
    // validates before writing — invalid YAML surfaces as an error, file untouched
    saveDoctrine(doctrineDir, yamlText);
    return { saved: true };
  });
  h("settings.spend", () => ({ ...monthSpend(db), ceiling: getCeiling(db) }));
  h("settings.setCeiling", (usd: number) => {
    setCeiling(db, usd);
    return { saved: true };
  });
  h("settings.get", (key: string) => getSetting(db, key));
  h("settings.set", (key: string, value: string) => setSetting(db, key, value));
  h("stt.transcribe", (wav: Uint8Array) => transcribe(doctrineDir, wav));
  // In-app LinkedIn messaging: your own login in a persistent child window. Read +
  // send directly on linkedin.com — no scraping, no third-party session service.
  h("app.openLinkedIn", () => {
    const w = new BrowserWindow({
      width: 1050, height: 760, title: "LinkedIn — POS",
      webPreferences: { partition: "persist:linkedin", nodeIntegration: false, contextIsolation: true },
    });
    w.loadURL("https://www.linkedin.com/messaging/");
    return { opened: true };
  });
  h("app.openFullDiskAccess", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
  );
}
