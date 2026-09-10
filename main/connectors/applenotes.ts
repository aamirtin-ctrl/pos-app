// Apple Notes people-capture bridge — macOS only.
//
// Owner ask 2026-08-13: one designated Apple Note is his drop-box for unstructured info
// about people he's met ("Abdeali Diwan" on a line, loose facts under it). POS ingests it
// on the sync tick and the note works as an INBOX: processed text is wiped; the durable
// record lives in capture_inbox (raw text lands there BEFORE the wipe — capture-inbox
// doctrine, nothing he wrote is allowed to evaporate).
//
// Shape mirrors reminders.ts deliberately: same osascript plumbing (runOsascript,
// asString, FIELD_SEP), same "never throw, return a typed report" contract.
//
// Interpretation is NOT here — the raw dump is gleaned later by crm/notesglean.ts via
// the capture drain, so a down LLM delays understanding but never loses text.

import type { ConnectorDeps, SyncReport } from "./common.ts";
import { getSetting } from "../db/db.ts";
import { runOsascript, asString, FIELD_SEP } from "../applecal.ts";
import { contentHash, contentSeen, logExtraction } from "../crm/commitments.ts";
import { recordCapture } from "../capture-inbox.ts";

/** Settings key: the Apple Notes note title POS watches. Empty/unset = connector off. */
export const NOTE_TITLE_KEY = "applenotes_capture_note";
/** Suggested title, used as the Settings placeholder — never assumed as a default. */
export const DEFAULT_NOTE_TITLE = "POS Inbox";
/** The note must be untouched this long before capture — never swallow a half-typed entry. */
export const MIN_QUIET_SECONDS = 300;
/** Read-script sentinel for "no note with that title". */
export const NOTE_NOT_FOUND = "!NOTENOTFOUND";

export interface NoteRead {
  secondsSinceModified: number;
  text: string;
}

/** Parse `"<seconds><FIELD_SEP><plaintext>"`. Split on the FIRST separator only. */
export function parseNoteRead(stdout: string): NoteRead | null {
  const raw = (stdout ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!raw || raw === NOTE_NOT_FOUND) return null;
  const idx = raw.indexOf(FIELD_SEP);
  if (idx <= 0) return null;
  const secs = Number(raw.slice(0, idx));
  if (!Number.isFinite(secs)) return null;
  return { secondsSinceModified: secs, text: raw.slice(idx + FIELD_SEP.length) };
}

/**
 * Capture only when the note has been quiet for MIN_QUIET_SECONDS and carries real text.
 * An "empty" note still echoes its own title as the first plaintext line, so a body that
 * IS just the title (what our own wipe leaves behind) doesn't count as content.
 */
export function shouldCapture(
  read: NoteRead,
  minQuietSeconds: number = MIN_QUIET_SECONDS,
  title?: string
): boolean {
  if (read.secondsSinceModified < minQuietSeconds) return false;
  const text = read.text.trim();
  if (!text) return false;
  if (title && text === title.trim()) return false;
  return true;
}

/** Seconds-since-modified + FIELD_SEP + plaintext, or the not-found sentinel. */
export function buildReadScript(title: string): string {
  return [
    `tell application "Notes"`,
    `  set matches to notes whose name is ${asString(title)}`,
    `  if (count of matches) is 0 then return "${NOTE_NOT_FOUND}"`,
    `  set n to item 1 of matches`,
    `  set secsAgo to ((current date) - (modification date of n)) as integer`,
    `  return (secsAgo as text) & "${FIELD_SEP}" & (plaintext of n)`,
    `end tell`,
  ].join("\n");
}

// ── the sync ─────────────────────────────────────────────────────────────────

type OsaRun = (script: string) => Promise<{ ok: true; stdout: string } | { ok: false; error: Error }>;

/**
 * One tick: read the designated note; if quiet and carrying new text, land it durably in
 * capture_inbox FIRST, then wipe the note. Content-hash dedupe (extraction_log) makes a
 * failed wipe safe: the next tick re-reads the same body, skips re-capture, retries the
 * wipe. recordCapture caps a row at 8000 chars — fine for an inbox note that is wiped
 * every tick, and the cap is preferable to losing the whole dump.
 */
export async function syncAppleNotes(
  deps: ConnectorDeps,
  opts: { run?: OsaRun } = {}
): Promise<SyncReport> {
  const { db } = deps;
  const run: OsaRun = opts.run ?? runOsascript;
  const report: SyncReport = { source: "applenotes", ingested: 0, skipped: 0, created: 0 };

  const title = (getSetting(db, NOTE_TITLE_KEY) ?? "").trim();
  if (!title) return report; // not configured — silent, like an unconfigured connector

  const read = await run(buildReadScript(title));
  if (!read.ok) return { ...report, error: read.error.message };
  if (read.stdout.trim() === NOTE_NOT_FOUND) {
    return { ...report, error: `No Apple Note titled "${title}" — create it or fix the title in Settings` };
  }
  const parsed = parseNoteRead(read.stdout);
  if (!parsed) return { ...report, error: "unreadable Notes output" };
  if (!shouldCapture(parsed, MIN_QUIET_SECONDS, title)) {
    // Recently modified or effectively empty. Never wipe what we did not capture.
    if (parsed.text.trim() && parsed.text.trim() !== title) report.skipped = 1;
    return report;
  }

  const text = parsed.text.trim();
  const hash = contentHash(text);
  if (!contentSeen(db, hash)) {
    recordCapture(db, "apple_notes", text);
    logExtraction(db, null, hash, "captured:apple_notes");
    report.ingested = 1;
  } else {
    report.skipped = 1; // already captured — this read exists only to retry the wipe
  }

  const wipe = await run(buildWipeScript(title));
  if (!wipe.ok) return { ...report, error: `captured but wipe failed: ${wipe.error.message}` };
  return report;
}

/**
 * Wipe = reset the body to just the title heading. Notes derives a note's name from its
 * first line; an empty body would rename the note and orphan the watcher.
 */
export function buildWipeScript(title: string): string {
  return [
    `tell application "Notes"`,
    `  set matches to notes whose name is ${asString(title)}`,
    `  if (count of matches) is 0 then return "${NOTE_NOT_FOUND}"`,
    `  set n to item 1 of matches`,
    `  set body of n to "<div><b>" & ${asString(title)} & "</b></div>"`,
    `  return "ok"`,
    `end tell`,
  ].join("\n");
}
