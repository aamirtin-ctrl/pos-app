// ALL ipcMain handlers — the single typed boundary between renderer and main.
// Channel names mirror the window.pos.* surface in renderer/src/pos.d.ts.

import { ipcMain, shell, dialog } from "electron";
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
import { captureOutcomes, adherenceStats, applyLearning } from "./engine/learning.ts";
import { runSync, syncStatus } from "./workers.ts";
import { saveDoctrine } from "./engine/doctrine.ts";
import { runLoopbackAuth, isGoogleConnected, hasGoogleCreds } from "./gcal/auth.ts";
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
  h("sync.embed", () => embedProfiles(db, secrets));

  // ── google ──
  h("gcal.connect", () => runLoopbackAuth(secrets, (url) => shell.openExternal(url)));
  h("gcal.connected", () => ({ connected: isGoogleConnected(secrets), hasCreds: hasGoogleCreds(secrets) }));
  h("gcal.reconcile", () => reconcileMovedEvents(db, secrets));
  h("gcal.events", (dateISO: string) => readAnchors(db, secrets, dateISO));

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
  h("app.openFullDiskAccess", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
  );
}
