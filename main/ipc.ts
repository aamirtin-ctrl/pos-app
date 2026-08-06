// ALL ipcMain handlers — the single typed boundary between renderer and main.
// Channel names mirror the window.pos.* surface in renderer/src/pos.d.ts.

import { ipcMain, shell, dialog, BrowserWindow } from "electron";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting, hasVec } from "./db/db.ts";
import { SecretStore, SECRET_NAMES } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import { monthSpend, getCeiling, setCeiling } from "./llm/meter.ts";
import {
  listPeople,
  getPerson,
  patchPerson,
  patchPersonWithExtract,
  mergePeople,
  deletePerson,
  type PatchExtractOpts,
} from "./crm/people.ts";
import {
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setHidden,
  setHideContacts,
  setSuppressFollowUps,
  assignToGroup,
  removeFromGroup,
  hiddenPersonIds,
} from "./crm/groups.ts";
import {
  reviewQueue,
  keepContacts,
  discardContacts,
  groupContacts,
  mergeCluster,
  dismissDuplicates,
  resolveAmbiguous,
  dismissAmbiguous,
} from "./crm/review.ts";
import { exportContactsCsv, defaultCsvFilename } from "./crm/export.ts";
import { rank } from "./crm/ranking.ts";
import {
  reconnectDue,
  refreshNextTouch,
  dismissPerson,
  undismissPerson,
  type DismissKind,
} from "./crm/reconnect.ts";
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
import { listFacts, setFact, deleteFact, resolveNamedDate, type SetFactInput } from "./context.ts";
import { embedProfiles, makeQueryEmbedder } from "./llm/embeddings.ts";
import * as planner from "./planner.ts";
import { handleCommand } from "./assistant.ts";
import { transcribe } from "./stt.ts";
import { generateDrafts, listDrafts, setDraftStatus, synthesizeVoices, getVoices } from "./crm/drafts.ts";
import {
  listInbox,
  sendEmail,
  sendIMessage,
  sendIMessageToChat,
  personHandles,
  type SendEmailArgs,
  type SendIMessageArgs,
  type SendIMessageChatArgs,
} from "./messaging.ts";
import { captureOutcomes, adherenceStats, applyLearning } from "./engine/learning.ts";
import { runSync, syncStatus } from "./workers.ts";
import { composeDigest, sendMorningDigest } from "./digest.ts";
import { recentInboxSenders } from "./capture.ts";
import { listMsgPlans } from "./msgplans.ts";
import { listMailAccounts, addMailAccount, removeMailAccount, addOAuthMailAccount, mailOAuthKey, type MailProvider } from "./connectors/gmail.ts";
import { saveDoctrine } from "./engine/doctrine.ts";
import {
  runLoopbackAuth,
  runLoopbackAuthFor,
  oauthClientFor,
  googleTokenSecret,
  cancelLoopbackAuth,
  isGoogleConnected,
  hasGoogleCreds,
  googleScopeStatus,
  needsReconsent,
  RECONSENT_REQUIRED,
} from "./gcal/auth.ts";
import { google } from "googleapis";
import { reconcileMovedEvents, readAnchors, commitmentToTask, commitmentToEvent, dropCommitmentCascade } from "./gcal/sync.ts";
import { listSubscriptions, addSubscription, removeSubscription, eventsForDate as icsEventsForDate, icsBlockType } from "./icscal.ts";
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
  // Hide-with-contacts (#5) is enforced HERE rather than inside listPeople: crm/people.ts
  // stays a pure query layer with no knowledge of group policy, and crm/groups.ts stays
  // free of a people.ts dependency. The composition lives at the one boundary both cross.
  h("people.list", (q?: string) => {
    const archived = hiddenPersonIds(db);
    const rows = listPeople(db, q);
    return archived.size === 0 ? rows : rows.filter((p) => !archived.has(p.id));
  });
  h("people.get", (id: number) => getPerson(db, id));
  h("people.patch", (id: number, fields: Record<string, unknown>) => patchPerson(db, id, fields));
  // About-save with intelligence (#10/#11): same whitelist patch, plus the "I just met
  // them" contact bump and — when the bio changed — a fast-tier extraction (role / tags /
  // next action) that degrades to the deterministic cue scan. The detected follow-up comes
  // back as a real commitment for the ContactDetail banner.
  h("people.patchWithExtract", (id: number, fields: Record<string, unknown>, opts?: PatchExtractOpts) =>
    patchPersonWithExtract(db, deps.llm(), id, fields, opts ?? {})
  );
  h("people.merge", (ids: number[]) => mergePeople(db, ids));
  // Quick-delete from Messaging/Contacts: hard-removes the person; aliases,
  // interactions and drafts cascade, commitments/tasks keep rows with refs nulled.
  h("people.delete", (id: number) => ({ deleted: deletePerson(db, id) }));
  h("people.reconnect", () => {
    refreshNextTouch(db);
    return reconnectDue(db);
  });
  // Reconnect row → Snooze 30d / 90d / Dismiss (#22). snoozeDays omitted = indefinite;
  // reconnectDue already skips anyone with a live dismissal of this kind.
  h("people.dismissReconnect", (personId: number, snoozeDays?: number | null, kind?: DismissKind) =>
    dismissPerson(db, personId, kind ?? "stale", snoozeDays ?? null)
  );
  h("people.undismissReconnect", (personId: number, kind?: DismissKind) => ({
    cleared: undismissPerson(db, personId, kind ?? "stale"),
  }));
  h("query.rank", async (inquiry: string) =>
    rank(db, deps.llm(), inquiry, { embedQuery: (hasVec() && makeQueryEmbedder(db, secrets)) || undefined })
  );

  // ── groups / tags (sidecars) ──
  // Bodies live in crm/groups.ts so they are testable without electron.
  h("groups.list", () => listGroups(db));
  h("groups.create", (name: string) => createGroup(db, name));
  h("groups.rename", (from: string, to: string) => ({ renamed: renameGroup(db, from, to) }));
  h("groups.delete", (name: string) => ({ deleted: deleteGroup(db, name) }));
  h("groups.assign", (personId: number, name: string) => ({ added: assignToGroup(db, [personId], name) }));
  // Bulk assign from the Contacts multi-select bar (#3 gap: bulk group assignment).
  h("groups.assignMany", (personIds: number[], name: string) => ({
    added: assignToGroup(db, personIds ?? [], name),
  }));
  h("groups.remove", (personId: number, name: string) => ({ removed: removeFromGroup(db, [personId], name) }));
  // hide = chip only; hideContacts = chip AND members drop out of contact lists.
  h("groups.hide", (name: string, hidden: boolean) => ({ ok: setHidden(db, name, hidden) }));
  h("groups.hideContacts", (name: string, on: boolean) => ({ ok: setHideContacts(db, name, on) }));
  h("groups.suppressFollowUps", (name: string, on: boolean) => ({ ok: setSuppressFollowUps(db, name, on) }));

  // ── review queue (#7 ambiguous · #8 new-contact triage · #9 duplicates) ──
  // Bodies live in crm/review.ts so they are testable without electron. One read
  // channel feeds the whole modal (contacts + duplicates + ambiguous + counts).
  h("review.pending", () => reviewQueue(db));
  h("review.keep", (ids: number[]) => ({ kept: keepContacts(db, ids ?? []) }));
  h("review.discard", (ids: number[]) => ({ discarded: discardContacts(db, ids ?? []) }));
  h("review.group", (ids: number[], name: string) => groupContacts(db, ids ?? [], name));
  // Same merge the Contacts merge-bar uses (crm/people.ts mergePeople): richest survivor,
  // field backfill, sidecars moved — plus clearing the survivor's 'unverified' tag.
  h("review.mergeCluster", (ids: number[]) => ({ kept: mergeCluster(db, ids ?? []) }));
  h("review.dismissDuplicates", (key: string) => ({ dismissed: dismissDuplicates(db, key) }));
  h("review.resolveAmbiguous", (key: string, personId: number) => resolveAmbiguous(db, key, personId));
  h("review.dismissAmbiguous", (key: string) => ({ dismissed: dismissAmbiguous(db, key) }));

  // ── CSV export (#20) ──
  // Body is pure (crm/export.ts); the dialog + write live here.
  h("people.exportCsv", async () => {
    const res = await dialog.showSaveDialog({
      title: "Export contacts as CSV",
      defaultPath: defaultCsvFilename(),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, exportContactsCsv(db), "utf8");
    return { saved: true, path: res.filePath };
  });

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
  // Accept IS the push (owner directive 2026-08-05). The local accept commits first; the
  // Google push is time-boxed and reported in `push`, never thrown.
  h("plan.accept", (planId: number) => planner.acceptPlan(db, planId, secrets));
  // Manual retry affordance only — the automatic paths are acceptPlan and the worker sweep.
  h("plan.push", (planId: number) => planner.pushPlanToGoogle(db, secrets, planId));

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
    listMailAccounts(secrets).map(({ id, provider, user, host, auth }) => ({ id, provider, user, host, auth: auth ?? "password" }))
  );
  h("mail.accounts.add", (acct: { provider: MailProvider; user: string; password: string; host?: string; port?: number }) => {
    const a = addMailAccount(secrets, acct);
    return { id: a.id, provider: a.provider, user: a.user, host: a.host };
  });
  h("mail.accounts.remove", (id: string) => {
    removeMailAccount(secrets, id);
    return { removed: true };
  });
  // Gmail via Google OAuth (XOAUTH2) — for Workspace accounts whose admin has
  // disabled app passwords. Tokens land under a pending key first (the address is
  // only known after consent), then get re-keyed to mail:<email>.
  h("mail.connectOAuth", async () => {
    const PENDING_KEY = "mail:pending";
    const res = await runLoopbackAuthFor(secrets, PENDING_KEY, (url) => shell.openExternal(url));
    if (!res.connected) {
      const reason = (res.error ?? "").toLowerCase();
      // Workspace admin refusals: Google reports access_denied / admin_policy_enforced
      // / org_internal-style errors when the client isn't allowed for the org.
      if (/admin|policy|access_denied|org_internal/.test(reason)) {
        return { connected: false, error: "admin_blocked" };
      }
      return { connected: false, error: res.error === "timeout" ? "timeout" : "canceled" };
    }
    try {
      // The consent screen doesn't tell us which account was picked — ask Gmail.
      const gmail = google.gmail({ version: "v1", auth: oauthClientFor(secrets, PENDING_KEY) });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress;
      if (!email) return { connected: false, error: "no_email" };
      // Re-key the token secret from the pending slot to the real address.
      const raw = secrets.get(googleTokenSecret(PENDING_KEY));
      if (raw) secrets.set(googleTokenSecret(mailOAuthKey(email)), raw);
      addOAuthMailAccount(secrets, email);
      return { connected: true, user: email };
    } catch (e) {
      return { connected: false, error: `profile_failed: ${(e as Error).message}` };
    } finally {
      secrets.delete(googleTokenSecret(PENDING_KEY));
    }
  });
  h("sync.embed", () => embedProfiles(db, secrets));

  // ── google ──
  h("gcal.connect", () => runLoopbackAuth(secrets, (url) => shell.openExternal(url)));
  h("gcal.cancel", () => {
    cancelLoopbackAuth();
    return { canceled: true };
  });
  h("gcal.connected", () => ({ connected: isGoogleConnected(secrets), hasCreds: hasGoogleCreds(secrets) }));
  // Same three facts plus canWrite: tokens minted before the calendar scope widened still
  // refresh fine but cannot create calendars, so "connected" alone is not enough to push.
  h("gcal.scopeStatus", () => googleScopeStatus(secrets));
  h("gcal.reconcile", () => reconcileMovedEvents(db, secrets));
  // Day-view events: Google anchors + subscribed webcal/ICS feeds, one list.
  // Appending here means the renderer needs zero changes to show ICS events.
  // Dedupe by RFC 5545 UID — a feed event Google also knows appears once.
  h("gcal.events", async (dateISO: string) => {
    const anchors = await readAnchors(db, secrets, dateISO);
    const out: unknown[] = [...anchors];
    try {
      const haveUids = new Set(anchors.map((a) => a.iCalUID).filter(Boolean));
      for (const ev of await icsEventsForDate(db, dateISO)) {
        if (ev.allDay || (ev.uid && haveUids.has(ev.uid))) continue;
        out.push({
          startMin: ev.startMin,
          endMin: ev.endMin,
          title: ev.title,
          blockType: icsBlockType(ev.title),
          gcalEventId: "",
          iCalUID: ev.uid,
          source: "ics",
        });
      }
    } catch (e) {
      // feeds are best-effort — the Google list must render regardless
      console.warn(`ics events unavailable: ${(e as Error).message}`);
    }
    return out;
  });

  // ── subscribed calendars (webcal/ICS) ──
  h("ics.list", () => listSubscriptions(db));
  h("ics.add", (url: string, name?: string) => addSubscription(db, url, name));
  h("ics.remove", (id: string) => removeSubscription(db, id));

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
  // The mirror writes to Google too, so it hits the same stale-scope wall — map it to the
  // one typed string the UI knows how to act on. (applecal.ts stays free of auth policy.)
  h("applecal.mirror", async (dateISO: string) => {
    try {
      return await mirrorToGoogle(db, secrets, dateISO);
    } catch (e) {
      if (needsReconsent(e)) throw new Error(RECONSENT_REQUIRED);
      throw e;
    }
  });

  // ── plans from messages ──
  // Manual trigger; the same connector also runs on the 15-min cron.
  h("msgplans.run", () => runSync(db, secrets, deps.llm(), "msgplans"));
  h("msgplans.list", () => listMsgPlans(db));

  // ── morning digest ──
  // Manual trigger for testing (`force` bypasses the once-per-day guard, never the
  // digest_enabled gate) + a compose-only preview. The scheduled path lives in workers.ts.
  h("digest.send", () => sendMorningDigest(db, secrets, { force: true }));
  h("digest.preview", () => composeDigest(db));

  // ── morning capture: third-party senders ──
  // Discovery for the Settings allowlist ("which address does my Alexa routine mail from?").
  // The allowlist itself is a plain setting — settings.get/set on `capture_allowed_senders`.
  h("capture.senders", (limit?: number) => recentInboxSenders(db, secrets, limit ?? 15));

  // ── unified inbox ──
  h("inbox.list", (opts?: { limit?: number }) => listInbox(db, opts ?? {}));
  // Both send paths are user-initiated only (explicit Send click in the renderer).
  h("inbox.sendEmail", (args: SendEmailArgs) => sendEmail(db, secrets, args));
  h("inbox.sendIMessage", (args: SendIMessageArgs) => sendIMessage(db, args));
  h("inbox.sendIMessageChat", (args: SendIMessageChatArgs) => sendIMessageToChat(db, args));
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

  // ── personal context ("About you") ──
  // Bodies live in main/context.ts. list() seeds the editable defaults on a first-ever
  // read, so the Settings card is never blank on a fresh install.
  h("context.list", () => listFacts(db));
  h("context.set", (fact: SetFactInput) => setFact(db, { source: "manual", ...fact }));
  h("context.delete", (key: string) => ({ deleted: deleteFact(db, key) }));
  // The commitment date picker asks this before prefilling: "meetup at the start of
  // school" resolves to the user's term-start anchor instead of defaulting to today.
  h("context.resolveDate", (phrase: string) => ({ date: resolveNamedDate(db, phrase) }));

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
