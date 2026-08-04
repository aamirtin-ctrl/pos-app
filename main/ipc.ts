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
import { listCommitments, confirmCommitment } from "./crm/commitments.ts";
import {
  journal,
  commitmentPrior,
  makeToTaskEntry,
  makeToEventEntry,
  makeDropEntry,
  makeConfirmEntry,
  makeUpdateTextEntry,
  makeTaskStatusEntry,
  makeDraftStatusEntry,
} from "./undo.ts";
import { addManual, entriesSince, catchUpParagraph } from "./worklog.ts";
import { embedProfiles, makeQueryEmbedder } from "./llm/embeddings.ts";
import * as planner from "./planner.ts";
import { handleCommand } from "./assistant.ts";
import { transcribe } from "./stt.ts";
import { generateDrafts, listDrafts, setDraftStatus, synthesizeVoices, getVoices } from "./crm/drafts.ts";
import { listInbox, sendEmail, sendIMessage, personHandles, type SendEmailArgs, type SendIMessageArgs } from "./messaging.ts";
import { captureOutcomes, adherenceStats, applyLearning } from "./engine/learning.ts";
import { runSync, syncStatus } from "./workers.ts";
import { listMsgPlans } from "./msgplans.ts";
import { listMailAccounts, addMailAccount, removeMailAccount, type MailProvider } from "./connectors/gmail.ts";
import { saveDoctrine } from "./engine/doctrine.ts";
import { runLoopbackAuth, cancelLoopbackAuth, isGoogleConnected, hasGoogleCreds } from "./gcal/auth.ts";
import { pushPlan, pushTasks, reconcileMovedEvents, readAnchors, commitmentToTask, commitmentToEvent, dropCommitmentCascade } from "./gcal/sync.ts";
import { notionAvailable, searchTargets, syncNotion, PARENT_PAGE_KEY } from "./notion.ts";
import {
  appleCalendarAvailable,
  readAppleEvents,
  mirrorToGoogle,
  listAppleCalendars,
  excludedCalendarNames,
} from "./applecal.ts";
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
  // User-initiated mutations record their inverse in the undo journal (⌘Z).
  // Automatic pipelines (workers.ts) call the same helpers directly and record nothing.
  h("commitments.list", (status?: string) => listCommitments(db, status));
  h("commitments.confirm", (id: number) => {
    const prior = commitmentPrior(db, id);
    confirmCommitment(db, id);
    if (prior) journal.record(makeConfirmEntry(db, id, prior));
  });
  // Drop (button AND swipe-delete) cascades: linked open local tasks are deleted and
  // their Google counterparts completed best-effort (time-boxed inside the helper).
  h("commitments.drop", (id: number) => {
    const prior = commitmentPrior(db, id);
    const res = dropCommitmentCascade(db, secrets, id);
    if (prior) journal.record(makeDropEntry(db, secrets, id, prior, res.deletedTasks));
    return res;
  });
  h("commitments.updateText", (id: number, description: string) => {
    if (!description?.trim()) throw new Error("empty description");
    const prior = commitmentPrior(db, id);
    // editing the text is confirmation — the user touched it, so it's real
    db.prepare("UPDATE commitment SET description = ?, confirmed_by_user = 1 WHERE id = ?").run(description.trim(), id);
    if (prior) journal.record(makeUpdateTextEntry(db, id, prior, description.trim()));
    return { saved: true };
  });
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
  // "Add task" button: confirm if needed, create the local task, then push to Google Tasks.
  // Body lives in gcal/sync.ts (commitmentToTask) so it is testable without electron;
  // local DB work is unconditional, the Google push is time-boxed and best-effort.
  // The renderer's inline picker always supplies dateISO (plan date + Google due).
  h("commitments.toTask", async (id: number, dateISO?: string) => {
    const prior = commitmentPrior(db, id);
    const res = await commitmentToTask(db, secrets, id, dateISO);
    if (prior) journal.record(makeToTaskEntry(db, secrets, id, prior, !res.duplicate, dateISO));
    return res;
  });
  // "Add event" button: pin a 60-min personal block. The renderer's inline picker
  // always supplies dateISO ("YYYY-MM-DD") + hhmm ("HH:MM"); needsDate is the fallback.
  h("commitments.toEvent", (id: number, dateISO?: string, hhmm?: string) => {
    const prior = commitmentPrior(db, id);
    const res = commitmentToEvent(db, id, dateISO, hhmm);
    if (!res.needsDate && prior) {
      journal.record(makeToEventEntry(db, id, prior, res.block_id ?? null, dateISO, hhmm));
    }
    return res;
  });

  // ── planner ──
  h("tasks.braindump", (text: string, dateISO: string) =>
    planner.braindump(db, doctrineDir, deps.llm(), text, dateISO)
  );
  h("tasks.list", (dateISO: string) => planner.listTasks(db, dateISO));
  h("tasks.setStatus", (id: number, status: string) => {
    const prior = db.prepare("SELECT status, completed_at FROM task WHERE id = ?").get(id) as
      | { status: string; completed_at: string | null } | undefined;
    const res = db.prepare(
      "UPDATE task SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE completed_at END WHERE id = ?"
    ).run(status, status, id);
    if (prior) journal.record(makeTaskStatusEntry(db, id, prior, status));
    return res;
  });
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

  // ── notion ──
  h("notion.available", () => notionAvailable(secrets));
  h("notion.targets", () => searchTargets(secrets));
  h("notion.setParent", (pageId: string) => {
    if (!pageId?.trim()) throw new Error("empty page id");
    setSetting(db, PARENT_PAGE_KEY, pageId.trim());
    return { saved: true };
  });
  h("notion.sync", () => syncNotion(db, secrets));

  // ── apple calendar (Calendar.app) ──
  // available() is also what triggers macOS's Automation permission prompt.
  h("applecal.available", () => appleCalendarAvailable());
  // names for the Settings picker; POS's own mirror calendars are never listed
  h("applecal.calendars", () => listAppleCalendars());
  h("applecal.events", (dateISO: string) => readAppleEvents(dateISO, { exclude: excludedCalendarNames(db) }));
  h("applecal.mirror", (dateISO: string) => mirrorToGoogle(db, secrets, dateISO));

  // ── plans from messages ──
  // Manual trigger; the same connector also runs on the 15-min cron.
  h("msgplans.run", () => runSync(db, secrets, deps.llm(), "msgplans"));
  h("msgplans.list", () => listMsgPlans(db));

  // ── unified inbox ──
  h("inbox.list", (opts?: { limit?: number }) => listInbox(db, opts ?? {}));
  // Both send paths are user-initiated only (explicit Send click in the renderer).
  h("inbox.sendEmail", (args: SendEmailArgs) => sendEmail(db, secrets, args));
  h("inbox.sendIMessage", (args: SendIMessageArgs) => sendIMessage(db, args));
  h("inbox.handles", (personId: number) => personHandles(db, personId));

  // ── messaging drafts + voices ──
  h("drafts.list", () => listDrafts(db));
  h("drafts.generate", () => generateDrafts(db, deps.llm()));
  h("drafts.setStatus", (id: number, status: "dismissed" | "sent") => {
    const prior = db.prepare("SELECT status FROM draft WHERE id = ?").get(id) as { status: string } | undefined;
    const res = setDraftStatus(db, id, status);
    if (prior) journal.record(makeDraftStatusEntry(db, id, prior.status, status));
    return res;
  });
  h("voice.synthesize", () => synthesizeVoices(db, deps.llm()));
  h("voice.get", () => getVoices(db));

  // ── undo / redo (⌘Z / ⌘⇧Z) ──
  h("undo.do", () => journal.undoLast());
  h("undo.redo", () => journal.redoLast());

  // ── worklog memory ──
  h("worklog.list", (sinceISO?: string) =>
    entriesSince(db, sinceISO ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
  );
  h("worklog.add", (title: string) => addManual(db, title));
  h("worklog.catchUp", (personId: number) => catchUpParagraph(db, deps.llm(), personId));

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
