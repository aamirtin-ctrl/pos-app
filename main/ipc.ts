// ALL ipcMain handlers — the single typed boundary between renderer and main.
// Channel names mirror the window.pos.* surface in renderer/src/pos.d.ts.

import { todayISO } from "./dates.ts";
import { ipcMain, shell, dialog, BrowserWindow } from "electron";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting, hasVec } from "./db/db.ts";
import { SecretStore, SECRET_NAMES } from "./secrets.ts";
import { LlmClient, llmHealth } from "./llm/provider.ts";
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
import { readPreferences, writePreferences, preferencesPath } from "./preferences.ts";
import { embedProfiles, makeQueryEmbedder } from "./llm/embeddings.ts";
import * as planner from "./planner.ts";
import { handleCommand } from "./assistant.ts";
import { recordCapture, markCaptureDone, markCaptureFailed, pendingCaptureCount } from "./capture-inbox.ts";
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
import { screenTimeAvailable, screenTimeDiagnostics, blockUsage, autoCaptureOutcomes } from "./screentime.ts";
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
import { reconcileMovedEvents, readAnchors, commitmentToTask, commitmentToEvent, dropCommitmentCascade, deleteGoogleEvent, moveGoogleEvent } from "./gcal/sync.ts";
import { listSubscriptions, addSubscription, removeSubscription, eventsForDate as icsEventsForDate, icsBlockType } from "./icscal.ts";
import {
  notionAvailable, searchTargets, syncNotion, PARENT_PAGE_KEY,
  listWorkspacePages, readPageBlocks, appendToPage, setTodoChecked, createWorkspacePage,
  queryDatabaseRows, updateBlockText, deleteBlock,
} from "./notion.ts";
import {
  appleCalendarAvailable,
  readAppleEvents,
  mirrorToGoogle,
  listAppleCalendars,
  excludedCalendarNames,
  deleteAppleEvent,
} from "./applecal.ts";
import {
  remindersAvailable,
  listReminderLists,
  readReminders,
  syncReminders,
  completeReminder,
} from "./connectors/reminders.ts";
import { purgeOrphanedGoogleTasks } from "./gtasks-sync.ts";
import fs from "node:fs";
import path from "node:path";
import {
  openPanel,
  closePanel,
  resizePanel,
  currentPanel,
  SERVICES,
} from "./webpanel.ts";
import type { Rectangle } from "electron";

// ── global hotkey (system-wide "start listening without leaving what I'm in") ──
//
// The registration itself lives in main/index.ts (it needs the HUD window and the
// globalShortcut module); the *validation* lives here because this file imports
// cleanly under `ELECTRON_RUN_AS_NODE=1` — nothing at module scope touches an
// Electron object — so tests/hotkey.test.ts can exercise it without booting an app.
// main/index.ts cannot be imported that way: it calls app.setPath() at module scope.

/** `setting` table key holding the user's chosen accelerator. */
export const GLOBAL_HOTKEY_KEY = "global_hotkey";

/**
 * Default global accelerator.
 *
 * The owner asked for Fn+Control. Fn is not bindable: Electron accelerators expose
 * exactly four modifiers (Command, Control, Alt/Option, Shift), and the macOS APIs
 * underneath — RegisterEventHotKey and NSEvent's modifier flags as Electron reads them
 * — do not carry Fn as a hotkey modifier at all. (macOS itself treats Fn/Globe as a
 * system key it reserves for emoji, dictation and F-key switching.) Seeing Fn press
 * would mean a CGEventTap native module plus Accessibility permission for the whole
 * app, which is a lot of machinery for one modifier.
 *
 * So: Control (which he did ask for) + Alt + Space. Space because it is the fastest key
 * to hit blind; Alt in the chord because bare `Control+Space` is what macOS hands to
 * input-source switching on most keyboards. Deliberately a real chord — a *global*
 * bare `Shift+A` would fire on every capital A the owner types in every application on
 * the Mac, and globalShortcut would happily register it. The in-app `Shift+A` in
 * renderer/src/App.tsx keeps needing no modifier — it only listens while POS is focused.
 */
export const DEFAULT_GLOBAL_HOTKEY = "Control+Alt+Space";

/** What `hotkey.get` / `hotkey.set` report. `registered: false` always carries an `error`. */
export interface HotkeyState {
  accelerator: string;
  registered: boolean;
  error?: string;
}

export type AcceleratorCheck =
  | { ok: true; accelerator: string }
  | { ok: false; error: string };

// Electron accelerator modifiers, lowercased → canonical spelling.
const MODIFIERS: Record<string, string> = {
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  alt: "Alt",
  option: "Option",
  altgr: "AltGr",
  shift: "Shift",
  super: "Super",
  meta: "Meta",
};

// Electron accelerator key codes. Single characters are handled separately.
const NAMED_KEYS = [
  "Plus", "Space", "Tab", "Capslock", "Numlock", "Scrolllock", "Backspace",
  "Delete", "Insert", "Return", "Enter", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Escape", "Esc",
  "VolumeUp", "VolumeDown", "VolumeMute",
  "MediaNextTrack", "MediaPreviousTrack", "MediaStop", "MediaPlayPause",
  "PrintScreen", "numdec", "numadd", "numsub", "nummult", "numdiv",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
];
const KEY_BY_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

// The punctuation Electron accepts as a single-character key code.
const PUNCTUATION = new Set(`)!@#$%^&*(:;+=<,_->.?/~\`{]|[}"'\\`.split(""));

// Fn (the Globe key on recent Macs) is the one thing the owner asked for that cannot
// be given. It is not an Electron accelerator modifier, and macOS does not deliver it
// as a modifier to the hotkey APIs Electron registers against — it is a hardware-level
// key the system reserves. Named separately from the generic "not a modifier" branch
// so Settings can say *why* rather than just listing the four that do work.
const FN_ALIASES = new Set(["fn", "function", "globe", "fnkey", "fn-key"]);
const FN_ERROR =
  "Fn (the Globe key) can't be used as a shortcut modifier on macOS — the system keeps it " +
  "for itself and never reports it to apps. Use Control, Option, Command or Shift instead — " +
  "the default Control+Alt+Space keeps the Control you wanted.";

/**
 * Pure accelerator check for the *global* shortcut, and the only place the "Shift is
 * not a modifier on its own" rule lives. Returns the canonically-spelled accelerator
 * (case and spacing normalized, `CmdOrCtrl` → `CommandOrControl`) or a message written
 * for the Settings row.
 *
 * Rejects: empty/whitespace, Fn in any position, no modifier at all, Shift as the only
 * modifier, a modifier in the key position, and key names Electron does not know.
 */
export function validateAccelerator(input: string): AcceleratorCheck {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: `Enter a shortcut — for example ${DEFAULT_GLOBAL_HOTKEY}.` };

  const parts = raw.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) {
    return { ok: false, error: `"${raw}" has an empty part — write the plus key as "Plus".` };
  }

  // Checked across every position: "Fn+Control" puts it in the modifier slot,
  // "Control+Fn" in the key slot, and both deserve the explanation rather than
  // the generic "not a modifier" / "not a key macOS knows".
  if (parts.some((p) => FN_ALIASES.has(p.toLowerCase()))) return { ok: false, error: FN_ERROR };

  const keyPart = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);

  const mods: string[] = [];
  for (const m of modParts) {
    const canon = MODIFIERS[m.toLowerCase()];
    if (!canon) {
      return { ok: false, error: `"${m}" is not a modifier — use Command, Control, CommandOrControl, Alt, Option or Shift.` };
    }
    mods.push(canon);
  }

  if (mods.length === 0) {
    return {
      ok: false,
      error: `"${raw}" has no modifier — a bare key registered system-wide would fire in every app you type in. Add Command, Control or Alt.`,
    };
  }
  if (mods.every((m) => m === "Shift")) {
    return {
      ok: false,
      error: "Shift alone is not a safe global modifier — it would intercept every capital letter you type. Add Command, Control or Alt.",
    };
  }

  // A modifier in the key position ("CommandOrControl+Shift") is not a shortcut.
  if (MODIFIERS[keyPart.toLowerCase()]) {
    return { ok: false, error: `"${keyPart}" is a modifier, not a key — finish the shortcut with a letter, number or named key.` };
  }

  let key: string;
  const named = KEY_BY_LOWER.get(keyPart.toLowerCase());
  if (named) {
    key = named;
  } else if (keyPart.length === 1 && /[a-z0-9]/i.test(keyPart)) {
    key = keyPart.toUpperCase();
  } else if (keyPart.length === 1 && PUNCTUATION.has(keyPart)) {
    key = keyPart;
  } else {
    return {
      ok: false,
      error: `"${keyPart}" isn't a key macOS knows — use a letter, a number, or a name like Space, Return or F5.`,
    };
  }

  return { ok: true, accelerator: [...mods, key].join("+") };
}

export interface IpcDeps {
  db: Db;
  secrets: SecretStore;
  doctrineDir: string;
  llm: () => LlmClient | null; // re-evaluated per call so newly-entered keys take effect
  /**
   * Live global-shortcut registration, owned by main/index.ts (it holds the window and
   * the globalShortcut module). `set` re-registers; persistence stays here so the
   * setting is only written for an accelerator that actually took.
   */
  hotkey: {
    get: () => HotkeyState;
    set: (accelerator: string) => HotkeyState;
  };
  /**
   * The floating voice HUD, owned by main/index.ts. The renderer reports when its
   * capture ended so main can hide the window at the right moment — the HUD cannot
   * hide itself without main, and main cannot know when the result has been on screen
   * long enough to read.
   */
  hud: {
    result: (payload: HudResult) => void;
  };
}

/** What the HUD renderer reports back through `hud.result`. */
export interface HudResult {
  status: "done" | "cancelled" | "error";
  text?: string;
  reply?: string;
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

  // Same contract as h(), plus the calling window. Docked web panels are children
  // of a specific window, so the handler needs to know which one asked — and the
  // sender is the only trustworthy answer (the renderer cannot name a window).
  const hWin = (channel: string, fn: (win: BrowserWindow, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) throw new Error("no_window");
        return { ok: true, data: await fn(win, ...args) };
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
    const today = todayISO();
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
  // The calendar's Google Tasks strip: outstanding work for the day PLUS everything undated,
  // which is otherwise invisible because only a scheduled task gets a block (owner ask
  // 2026-08-06 — "a place for me to see the Google tasks").
  h("tasks.strip", (dateISO: string) => planner.tasksForStrip(db, dateISO));
  h("tasks.setStatus", (id: number, status: string) => {
    const prior = db.prepare("SELECT status, completed_at FROM task WHERE id = ?").get(id) as
      | { status: string; completed_at: string | null } | undefined;
    const res = db.prepare(
      "UPDATE task SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE completed_at END WHERE id = ?"
    ).run(status, status, id);
    // Snapshot the calendar event the moment work is marked done, independent of whatever
    // plan/block rows happen to exist later — see migration 14 / protectedEventIds.
    if (status === "done") {
      db.prepare(
        `UPDATE task SET gcal_event_id = COALESCE(gcal_event_id, (
           SELECT b.gcal_event_id FROM block b WHERE b.task_id = task.id AND b.gcal_event_id IS NOT NULL
            ORDER BY b.id DESC LIMIT 1
         )) WHERE id = ?`
      ).run(id);
    }
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
  // Dragging a block PINS it and re-solves the day around it, so breaks and transitions are
  // recomputed by doctrine instead of dragged along by hand (owner ask 2026-08-06).
  h("plan.moveBlock", (blockId: number, startMin: number) =>
    planner.moveBlock(db, doctrineDir, secrets, deps.llm(), blockId, startMin));
  h("plan.resizeBlock", (blockId: number, startMin: number, endMin: number) =>
    planner.resizeBlock(db, doctrineDir, secrets, deps.llm(), blockId, startMin, endMin));
  h("plan.moveBlockToDay", (blockId: number, dateISO: string) =>
    planner.moveBlockToDay(db, doctrineDir, secrets, deps.llm(), blockId, dateISO));
  h("plan.unpinBlock", (blockId: number) =>
    planner.unpinBlock(db, doctrineDir, secrets, deps.llm(), blockId));

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

  // ── screen time (objective outcomes) ──
  h("screentime.available", () => screenTimeAvailable());
  h("screentime.diagnostics", () => screenTimeDiagnostics());
  h("screentime.block", (blockId: number) => blockUsage(db, blockId));
  h("screentime.autoCapture", (dateISO: string) => {
    const res = autoCaptureOutcomes(db, dateISO);
    if (res.captured === 0) return { ...res, doctrineUpdated: false };
    const file = path.join(doctrineDir, "doctrine.yaml");
    const { yaml, changed } = applyLearning(fs.readFileSync(file, "utf8"), db);
    if (changed) fs.writeFileSync(file, yaml, "utf8");
    return { ...res, doctrineUpdated: changed };
  });

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

  // Delete an event shown on the day view (select → ⌫). The events the day shows are
  // real Google-calendar events (POS's own calendars are excluded from anchors), so the
  // primary path is a Google delete by (calendarId, eventId). If the event is flagged as
  // Apple-sourced we also remove the Calendar.app original so the mirror can't re-create it.
  // ICS-feed rows have no gcalEventId — those are read-only subscriptions, reported as such.
  h("calendar.deleteEvent", async (ev: {
    gcalEventId?: string; calendarId?: string; iCalUID?: string; source?: string;
  }) => {
    if (!ev || typeof ev !== "object") return { ok: false, error: "no event given" };
    if (ev.gcalEventId && ev.calendarId) {
      const g = await deleteGoogleEvent(secrets, ev.calendarId, ev.gcalEventId);
      if (!g.ok) return { ok: false, error: g.error };
      // Apple-original cleanup is a full-calendar AppleScript scan — 30-90s on a cold
      // Calendar.app. Awaiting it here held the IPC reply hostage and the popover just
      // said "Deleting…" until the owner gave up ("it gets stuck", 2026-08-13). The
      // Google copy — the one he can see — is already gone; the Apple original can go
      // in its own time, and a failure only means the next mirror pass re-mirrors one
      // event, which the delete button can remove again.
      if (ev.source === "apple" && ev.iCalUID) {
        void deleteAppleEvent(ev.iCalUID).catch((e) =>
          console.warn(`applecal: background delete of ${ev.iCalUID} failed: ${(e as Error).message}`));
      }
      return { ok: true };
    }
    if (ev.source === "apple" && ev.iCalUID) {
      const a = await deleteAppleEvent(ev.iCalUID);
      return a.ok ? { ok: true } : { ok: false, error: a.error.message };
    }
    return { ok: false, error: "This event is a read-only subscription and can't be deleted from POS." };
  });

  // Drag-to-move for external calendar events: patch the Google event's times. Minutes are
  // local wall-clock on dateISO; the Date constructor makes them absolute in this machine's
  // timezone, which is the same convention the anchors reader parses back.
  h("calendar.moveEvent", async (ev: {
    gcalEventId?: string; calendarId?: string; dateISO?: string; startMin?: number; durationMin?: number;
  }) => {
    if (!ev?.gcalEventId || !ev.calendarId || !ev.dateISO || ev.startMin == null || !ev.durationMin) {
      return { ok: false, error: "missing event, date, or time" };
    }
    const [y, mo, d] = ev.dateISO.split("-").map(Number);
    const start = new Date(y, mo - 1, d, 0, ev.startMin);
    const end = new Date(y, mo - 1, d, 0, ev.startMin + ev.durationMin);
    return moveGoogleEvent(secrets, ev.calendarId, ev.gcalEventId, start.toISOString(), end.toISOString());
  });

  // ── google tasks maintenance ──
  // One-shot purge of rows POS orphaned in its Google list (the tentative-push duplicate
  // loop left ~1200). Dry-run unless apply=true; never touches rows he created himself.
  h("gtasks.purgePreview", () => purgeOrphanedGoogleTasks(db, secrets, { apply: false }));
  h("gtasks.purgeApply", () => purgeOrphanedGoogleTasks(db, secrets, { apply: true }));

  // ── apple reminders (Reminders.app) ──
  // Owner directive 2026-08-10: iOS's own detection in Messages + a one-tap reminder is
  // the task source now; POS imports what HE chose instead of inferring tasks from text.
  h("reminders.available", () => remindersAvailable());
  h("reminders.lists", () => listReminderLists());
  h("reminders.list", () => readReminders(false));
  h("reminders.sync", () => syncReminders(db, todayISO()));
  h("reminders.complete", (id: string) => completeReminder(id));

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
  // The workspace tab (owner ask 2026-08-06): HIS Notion pages, read and written live. No
  // local mirror — "they all talk to each other" holds because there is only ever one copy.
  h("notion.pages", () => listWorkspacePages(secrets));
  h("notion.page", (pageId: string) => readPageBlocks(secrets, pageId));
  h("notion.rows", (databaseId: string) => queryDatabaseRows(secrets, databaseId));
  h("notion.append", (pageId: string, line: string, kind?: "todo" | "text", after?: string) =>
    appendToPage(secrets, pageId, line, kind ?? "todo", after));
  h("notion.updateBlock", (blockId: string, kind: "todo" | "text", line: string) =>
    updateBlockText(secrets, blockId, kind, line));
  h("notion.deleteBlock", (blockId: string) => deleteBlock(secrets, blockId));
  h("notion.check", (blockId: string, checked: boolean) => setTodoChecked(secrets, blockId, checked));
  h("notion.createPage", (title: string, firstLine?: string) =>
    createWorkspacePage(db, secrets, title, { firstLine }));

  // ── apple calendar (Calendar.app) ──
  // available() is also what triggers macOS's Automation permission prompt.
  h("applecal.available", () => appleCalendarAvailable());
  // names for the Settings picker; POS's own mirror calendars are never listed
  h("applecal.calendars", () => listAppleCalendars());
  h("applecal.events", (dateISO: string) => readAppleEvents(dateISO, { exclude: excludedCalendarNames(db), db }));
  // Per-event delete from the day view (select an event → ⌫). Removes it from
  // Calendar.app by UID; the next scan/refresh reflects it. Returns {ok, deleted}.
  h("applecal.deleteEvent", (uid: string, calendar?: string) => deleteAppleEvent(uid, calendar));
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

  // ── personal preferences (the free-text half of the same memory) ──
  // A plain Markdown file next to doctrine.yaml, owned by the user. get() seeds the
  // commented template on a first-ever read; set() validates nothing but non-empty,
  // because there is no schema he can get wrong in his own prose.
  h("prefs.get", () => readPreferences(doctrineDir));
  h("prefs.set", (md: string) => {
    writePreferences(doctrineDir, md);
    return { saved: true };
  });
  // "Reveal in Finder" is the proof it is really a file he owns, not app state.
  h("prefs.reveal", () => {
    readPreferences(doctrineDir); // never reveal a path that doesn't exist yet
    shell.showItemInFolder(preferencesPath(doctrineDir));
    return { revealed: true };
  });

  // ── unified assistant ──
  //
  // The raw text is recorded BEFORE it is interpreted (owner ask 2026-08-06). His Gemini quota
  // ran out at 18:18 and everything he typed here afterwards produced no task, no event, no
  // note and no visible error — the input was simply gone. Now it is on disk first, and a
  // failed interpretation leaves a queued row the worker re-runs once the model is back.
  h("assistant.command", async (text: string) => {
    const captureId = recordCapture(db, "sparkle", text);
    try {
      const healthy = llmHealth(db, secrets).ok;
      const res = await handleCommand({ db, secrets, doctrineDir, llm: deps.llm() }, text);
      // `degraded` is provenance, not a retry marker: the fallback DID act (created tasks,
      // filed notes), so re-running the same text when the model returns would duplicate its
      // output. What it buys is an audit trail — a row that says "this was interpreted
      // without the model" is findable, where before it was indistinguishable from a full parse.
      if (captureId !== null) markCaptureDone(db, captureId, { kind: res.kind, degraded: !healthy });
      return res;
    } catch (e) {
      if (captureId !== null) markCaptureFailed(db, captureId, (e as Error).message);
      throw e;
    }
  });
  h("capture.pending", () => pendingCaptureCount(db));

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
  // Is the AI actually working? Polled by the settings gear (red ring), the Spend card and
  // the planner footer — all of which otherwise show a silent deterministic fallback.
  h("llm.health", () => llmHealth(db, secrets));
  h("settings.setCeiling", (usd: number) => {
    setCeiling(db, usd);
    return { saved: true };
  });
  h("settings.get", (key: string) => getSetting(db, key));
  h("settings.set", (key: string, value: string) => setSetting(db, key, value));

  // ── global hotkey ──
  // get() reports what main/index.ts actually managed to register at startup, including
  // the failure — a shortcut another app already owns must be visible in Settings, not
  // silently dead. set() validates first (so a Shift-only chord never reaches
  // globalShortcut), re-registers, and only persists once registration succeeded.
  h("hotkey.get", (): HotkeyState => deps.hotkey.get());
  h("hotkey.set", (accelerator: string): HotkeyState => {
    const v = validateAccelerator(accelerator ?? "");
    if (!v.ok) return { accelerator: (accelerator ?? "").trim(), registered: false, error: v.error };
    const state = deps.hotkey.set(v.accelerator);
    if (state.registered) setSetting(db, GLOBAL_HOTKEY_KEY, state.accelerator);
    return state;
  });
  // The floating HUD saying "I'm finished — put me away". Sent after the result has
  // been readable for a beat, or immediately on Escape/click-to-cancel.
  h("hud.result", (payload: HudResult) => {
    deps.hud.result(payload ?? { status: "cancelled" });
    return { hidden: true };
  });
  h("stt.transcribe", (wav: Uint8Array) => transcribe(doctrineDir, wav));
  // ── docked in-app web panels (main/webpanel.ts) ──
  // Snapchat and Instagram DMs exist only on the web; these dock the real site in
  // a right-hand column of the Messaging screen, each in its own persistent session.
  // The renderer owns the layout and reports the rect it reserved.
  hWin("panel.open", (win, serviceId: string, bounds?: Rectangle) => openPanel(win, serviceId, bounds));
  hWin("panel.close", (win) => {
    closePanel(win);
    return { closed: true };
  });
  hWin("panel.bounds", (win, bounds: Rectangle) => resizePanel(win, bounds));
  h("panel.current", () => currentPanel());
  h("panel.services", () =>
    Object.values(SERVICES).map((s) => ({ id: s.id, label: s.label, dmOnly: !!s.allowPathPrefixes }))
  );
  // Back-compat: the old separate-window LinkedIn opener. Same login, same
  // persist:linkedin partition — now it just opens the docked panel instead.
  hWin("app.openLinkedIn", (win) => {
    openPanel(win, "linkedin");
    return { opened: true };
  });
  h("app.openFullDiskAccess", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
  );
}
