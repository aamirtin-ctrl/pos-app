# Apple Notes People-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** POS watches one designated Apple Note the owner dumps unstructured people-info into, files the facts onto the right CRM people (asking in the review modal when unsure), and wipes the note.

**Architecture:** A new osascript connector (`main/connectors/applenotes.ts`) reads the note each sync tick and lands raw text durably in the existing `capture_inbox` before wiping the note. A new gleaning module (`main/crm/notesglean.ts`) interprets captured dumps with ONE LLM call per dump, resolves each person-chunk through `resolveHandle` plus a unique-name relaxation, applies facts to `person.bio` under the existing mined-bullets marker, and queues unresolvable chunks into the review modal.

**Tech Stack:** TypeScript (Electron main), better-sqlite3 via `main/db/db.ts`, AppleScript via `runOsascript` (main/applecal.ts), vitest.

Spec: `docs/superpowers/specs/2026-08-13-apple-notes-capture-design.md`

## Global Constraints

- One LLM call per captured dump, never per chunk (quota discipline, see main/crm/enrich.ts header).
- Raw text lands in `capture_inbox` BEFORE the note is wiped; never the reverse.
- LLM fields: leave absent rather than infer; **facts[] are the payload that matters most**.
- Name alone auto-attaches ONLY on a unique normalized-name match; everything else asks.
- New people from notes: tier 2, NO `unverified` tag (the note is owner-authored).
- Chunks with no name and no phone/email → review queue, never a nameless person, never dropped.
- Facts append under the existing `MINED_MARKER` ("— From conversations —", crm/enrich.ts) so `splitBio`/`composeBio` and profile synthesis keep working — a deliberate refinement of the spec's "— From notes —" wording; do NOT introduce a second marker.
- Match existing style: comment density, `// ──` section bars, "never throw from a connector" contract.
- All tests: vitest, tmpdir + `openDb` pattern (see tests/crm/identity.test.ts:19-26).
- Commit after every green test cycle. Never commit the pre-existing dirty files in the repo root (`.gitignore`, `e2e-tmp.mts`, `probe-entry.ts`, `tests/_*.test.ts`, `tests/__upg.test.ts`) — `git add` only your files.

---

### Task 1: Capture source + connector pure helpers

**Files:**
- Modify: `main/capture-inbox.ts:27` (CaptureSource union)
- Create: `main/connectors/applenotes.ts` (pure helpers only in this task)
- Test: `tests/connectors/applenotes.test.ts`

**Interfaces:**
- Consumes: `FIELD_SEP`, `asString` from `main/applecal.ts`.
- Produces (used by Task 2): `NOTE_TITLE_KEY = "applenotes_capture_note"`, `DEFAULT_NOTE_TITLE = "POS Inbox"`, `MIN_QUIET_SECONDS = 300`, `NOTE_NOT_FOUND = "!NOTENOTFOUND"`, `parseNoteRead(stdout: string): NoteRead | null`, `shouldCapture(read: NoteRead, minQuietSeconds?: number): boolean`, `buildReadScript(title: string): string`, `buildWipeScript(title: string): string`, `interface NoteRead { secondsSinceModified: number; text: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/connectors/applenotes.test.ts
import { describe, it, expect } from "vitest";
import { FIELD_SEP } from "../../main/applecal.ts";
import {
  parseNoteRead,
  shouldCapture,
  buildReadScript,
  buildWipeScript,
  NOTE_NOT_FOUND,
  MIN_QUIET_SECONDS,
} from "../../main/connectors/applenotes.ts";

describe("parseNoteRead", () => {
  it("parses seconds-since-modified and plaintext", () => {
    const r = parseNoteRead(`400${FIELD_SEP}Abdeali Diwan\nmet at the gym`);
    expect(r).toEqual({ secondsSinceModified: 400, text: "Abdeali Diwan\nmet at the gym" });
  });
  it("keeps FIELD_SEP-free newlines and trailing text intact", () => {
    const r = parseNoteRead(`10${FIELD_SEP}a${FIELD_SEP}b`);
    // only the FIRST separator splits — note text could theoretically contain the char
    expect(r).toEqual({ secondsSinceModified: 10, text: `a${FIELD_SEP}b` });
  });
  it("returns null for the not-found marker and for junk", () => {
    expect(parseNoteRead(NOTE_NOT_FOUND)).toBeNull();
    expect(parseNoteRead("")).toBeNull();
    expect(parseNoteRead(`abc${FIELD_SEP}text`)).toBeNull();
  });
});

describe("shouldCapture", () => {
  it("false while the note was modified recently (mid-typing guard)", () => {
    expect(shouldCapture({ secondsSinceModified: 60, text: "stuff" })).toBe(false);
    expect(shouldCapture({ secondsSinceModified: MIN_QUIET_SECONDS - 1, text: "stuff" })).toBe(false);
  });
  it("true once quiet and non-empty", () => {
    expect(shouldCapture({ secondsSinceModified: MIN_QUIET_SECONDS, text: "stuff" })).toBe(true);
  });
  it("false for whitespace-only text", () => {
    expect(shouldCapture({ secondsSinceModified: 9999, text: "  \n " })).toBe(false);
  });
  it("false when the text is just the note title line (empty note shows its name)", () => {
    expect(shouldCapture({ secondsSinceModified: 9999, text: "POS Inbox" }, MIN_QUIET_SECONDS, "POS Inbox")).toBe(false);
  });
});

describe("scripts", () => {
  it("read script targets the exact title, escaped", () => {
    const s = buildReadScript(`My "People" Note`);
    expect(s).toContain(`\\"People\\"`);
    expect(s).toContain("plaintext");
  });
  it("wipe script sets the body to just the title heading", () => {
    const s = buildWipeScript("POS Inbox");
    expect(s).toContain("set body of");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/pos && npx vitest run tests/connectors/applenotes.test.ts`
Expected: FAIL — cannot resolve `main/connectors/applenotes.ts`.

- [ ] **Step 3: Write minimal implementation**

First the one-line union change in `main/capture-inbox.ts` (line 27):

```ts
/** Where he said it. Every surface that can carry an instruction writes one of these. */
export type CaptureSource = "sparkle" | "self_email" | "imessage" | "alexa" | "apple_notes";
```

Then `main/connectors/applenotes.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/pos && npx vitest run tests/connectors/applenotes.test.ts`
Expected: PASS (all). Also run `npx vitest run tests/capture-inbox.test.ts` — the union widening must not break existing tests.

- [ ] **Step 5: Commit**

```bash
cd ~/pos && git add main/capture-inbox.ts main/connectors/applenotes.ts tests/connectors/applenotes.test.ts && git commit -m "feat(applenotes): capture source + connector pure helpers"
```

---

### Task 2: `syncAppleNotes` — read, record durably, wipe

**Files:**
- Modify: `main/connectors/applenotes.ts` (append)
- Test: `tests/connectors/applenotes.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers; `recordCapture(db, "apple_notes", text)` (main/capture-inbox.ts:56); `contentHash(text)`, `contentSeen(db, hash)`, `logExtraction(db, null, hash, verdict)` (main/crm/commitments.ts:151,176,190); `getSetting` (main/db/db.ts); `ConnectorDeps`, `SyncReport` (main/connectors/common.ts:18).
- Produces (used by Task 6): `syncAppleNotes(deps: ConnectorDeps, opts?: { run?: (script: string) => Promise<{ ok: true; stdout: string } | { ok: false; error: Error }> }): Promise<SyncReport>` with `report.source === "applenotes"`.

- [ ] **Step 1: Write the failing test** (append to `tests/connectors/applenotes.test.ts`)

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach } from "vitest";
import { openDb, setSetting, type Db } from "../../main/db/db.ts";
import { syncAppleNotes, NOTE_TITLE_KEY } from "../../main/connectors/applenotes.ts";

// Fake osascript: scripts containing "plaintext" are reads, "set body" are wipes.
function fakeRun(readStdout: string, opts: { failWipe?: boolean } = {}) {
  const calls: string[] = [];
  const run = async (script: string) => {
    if (script.includes("set body")) {
      calls.push("wipe");
      if (opts.failWipe) return { ok: false as const, error: new Error("nope") };
      return { ok: true as const, stdout: "ok" };
    }
    calls.push("read");
    return { ok: true as const, stdout: readStdout };
  };
  return { run, calls };
}

describe("syncAppleNotes", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-applenotes-"));
    db = openDb(path.join(dir, "pos.db"));
    setSetting(db, NOTE_TITLE_KEY, "POS Inbox");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = () => ({ db }) as never;
  const pending = () =>
    db.prepare("SELECT source, raw_text FROM capture_inbox").all() as { source: string; raw_text: string }[];

  it("records the dump into capture_inbox, then wipes", async () => {
    const { run, calls } = fakeRun(`999${FIELD_SEP}POS Inbox\nAbdeali Diwan\nmet at gym`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r).toMatchObject({ source: "applenotes", ingested: 1, error: undefined });
    expect(pending()).toEqual([{ source: "apple_notes", raw_text: "POS Inbox\nAbdeali Diwan\nmet at gym" }]);
    expect(calls).toEqual(["read", "wipe"]);
  });

  it("skips a recently-modified note without wiping", async () => {
    const { run, calls } = fakeRun(`10${FIELD_SEP}POS Inbox\nhalf-typed`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
    expect(pending()).toEqual([]);
    expect(calls).toEqual(["read"]);
  });

  it("same content twice (earlier wipe failed) captures once but still retries the wipe", async () => {
    const stdout = `999${FIELD_SEP}POS Inbox\nAbdeali Diwan`;
    const first = fakeRun(stdout, { failWipe: true });
    const r1 = await syncAppleNotes(deps(), { run: first.run });
    expect(r1.ingested).toBe(1);
    expect(r1.error).toBeTruthy(); // wipe failure is reported, capture stands
    const second = fakeRun(stdout);
    const r2 = await syncAppleNotes(deps(), { run: second.run });
    expect(r2.ingested).toBe(0); // content-hash dedupe
    expect(second.calls).toEqual(["read", "wipe"]); // wipe retried
    expect(pending()).toHaveLength(1);
  });

  it("missing note reports an error naming the title", async () => {
    const run = async () => ({ ok: true as const, stdout: "!NOTENOTFOUND" });
    const r = await syncAppleNotes(deps(), { run });
    expect(r.error).toContain("POS Inbox");
  });

  it("unset title = connector off", async () => {
    setSetting(db, NOTE_TITLE_KEY, "");
    const { run, calls } = fakeRun(`999${FIELD_SEP}x`);
    const r = await syncAppleNotes(deps(), { run });
    expect(r).toMatchObject({ ingested: 0, skipped: 0 });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/pos && npx vitest run tests/connectors/applenotes.test.ts`
Expected: FAIL — `syncAppleNotes` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `main/connectors/applenotes.ts`)

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/pos && npx vitest run tests/connectors/applenotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/pos && git add main/connectors/applenotes.ts tests/connectors/applenotes.test.ts && git commit -m "feat(applenotes): syncAppleNotes — durable capture then wipe"
```

---

### Task 3: Glean parsing + unique-name match + chunk application

**Files:**
- Create: `main/crm/notesglean.ts`
- Test: `tests/crm/notesglean.test.ts`

**Interfaces:**
- Consumes: `resolveHandle`, `HandleInput` (main/crm/identity.ts); `normalizeName`, `normalizePhone`, `normalizeEmail` (main/crm/normalize.ts); `splitBio`, `composeBio` (main/crm/enrich.ts:93,107); `addAlias(db, personId, kind, value, source)` (main/connectors/common.ts:130); `getSetting`, `setSetting` (main/db/db.ts).
- Produces (used by Tasks 4, 5):
  - `interface NoteChunk { name?: string; org?: string; role?: string; phone?: string; email?: string; facts: string[] }`
  - `parseGleanChunks(raw: unknown): NoteChunk[]`
  - `uniqueNameMatch(db: Db, name: string): number | null`
  - `applyChunk(db: Db, chunk: NoteChunk, personId: number): void`
  - `createPersonFromChunk(db: Db, chunk: NoteChunk): number` (requires `chunk.name`; throws otherwise)

- [ ] **Step 1: Write the failing test**

```ts
// tests/crm/notesglean.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import { MINED_MARKER } from "../../main/crm/enrich.ts";
import {
  parseGleanChunks,
  uniqueNameMatch,
  applyChunk,
  createPersonFromChunk,
} from "../../main/crm/notesglean.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-notesglean-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(name: string, fields: { org?: string; bio?: string } = {}): number {
  const r = db
    .prepare("INSERT INTO person (display_name, org, bio) VALUES (?, ?, ?)")
    .run(name, fields.org ?? null, fields.bio ?? null);
  return Number(r.lastInsertRowid);
}
const person = (id: number) =>
  db.prepare("SELECT * FROM person WHERE id = ?").get(id) as Record<string, unknown>;

describe("parseGleanChunks", () => {
  it("keeps well-formed chunks, all fields optional, facts default []", () => {
    const out = parseGleanChunks([
      { name: "Abdeali Diwan", facts: ["met at the gym", "into climbing"] },
      { phone: "555-111-2222", facts: ["said call about apt"] },
      { name: "Sara" },
    ]);
    expect(out).toEqual([
      { name: "Abdeali Diwan", facts: ["met at the gym", "into climbing"] },
      { phone: "555-111-2222", facts: ["said call about apt"] },
      { name: "Sara", facts: [] },
    ]);
  });
  it("drops junk: non-arrays, non-objects, empty chunks, non-string facts", () => {
    expect(parseGleanChunks("nope")).toEqual([]);
    expect(parseGleanChunks([null, 5, {}, { facts: [] }, { name: "X", facts: [1, "ok", ""] }])).toEqual([
      { name: "X", facts: ["ok"] },
    ]);
  });
});

describe("uniqueNameMatch", () => {
  it("exactly one normalized-name hit → that id", () => {
    const id = addPerson("Abdeali Diwan");
    addPerson("Someone Else");
    expect(uniqueNameMatch(db, "abdeali  diwan")).toBe(id);
  });
  it("zero or multiple hits → null", () => {
    expect(uniqueNameMatch(db, "Nobody Here")).toBeNull();
    addPerson("Jay Shah");
    addPerson("Jay Shah");
    expect(uniqueNameMatch(db, "Jay Shah")).toBeNull();
  });
});

describe("applyChunk", () => {
  it("appends facts under MINED_MARKER without touching the user-authored head", () => {
    const id = addPerson("Abdeali Diwan", { bio: "My climbing friend." });
    applyChunk(db, { name: "Abdeali Diwan", facts: ["works at Stripe", "moving to SF"] }, id);
    const bio = person(id).bio as string;
    expect(bio.startsWith("My climbing friend.")).toBe(true);
    expect(bio).toContain(MINED_MARKER);
    expect(bio).toContain("works at Stripe");
    // idempotent: same facts again do not duplicate
    applyChunk(db, { name: "Abdeali Diwan", facts: ["works at Stripe"] }, id);
    expect((person(id).bio as string).match(/works at Stripe/g)).toHaveLength(1);
  });
  it("fills empty org/role, never overwrites, adds phone/email aliases", () => {
    const id = addPerson("Abdeali Diwan", { org: "Stripe" });
    applyChunk(
      db,
      { name: "Abdeali Diwan", org: "Airbnb", role: "engineer", phone: "+1 (555) 111-2222", email: "AD@x.com", facts: [] },
      id
    );
    expect(person(id).org).toBe("Stripe"); // existing wins
    expect(person(id).role).toBe("engineer"); // empty filled
    const aliases = db.prepare("SELECT kind, value FROM alias WHERE person_id = ? ORDER BY kind").all(id);
    expect(aliases).toEqual([
      { kind: "email", value: "ad@x.com" },
      { kind: "phone", value: "+15551112222" },
    ]);
  });
  it("records a channel='notes' interaction carrying the chunk text", () => {
    const id = addPerson("Abdeali Diwan");
    applyChunk(db, { name: "Abdeali Diwan", facts: ["met at gym"] }, id);
    const i = db.prepare("SELECT channel, body_raw FROM interaction WHERE person_id = ?").get(id) as {
      channel: string;
      body_raw: string;
    };
    expect(i.channel).toBe("notes");
    expect(i.body_raw).toContain("met at gym");
  });
});

describe("createPersonFromChunk", () => {
  it("creates tier-2, no unverified tag, applies the chunk", () => {
    const id = createPersonFromChunk(db, { name: "New Guy", org: "Acme", facts: ["met at conf"] });
    expect(person(id).tier).toBe(2);
    expect(person(id).org).toBe("Acme");
    const tag = db.prepare("SELECT 1 FROM person_tag WHERE person_id = ? AND tag = 'unverified'").get(id);
    expect(tag).toBeUndefined();
    expect(person(id).bio as string).toContain("met at conf");
  });
  it("throws without a name", () => {
    expect(() => createPersonFromChunk(db, { facts: ["x"] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/pos && npx vitest run tests/crm/notesglean.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// main/crm/notesglean.ts
// People-gleaning for the Apple Notes drop-box (spec:
// docs/superpowers/specs/2026-08-13-apple-notes-capture-design.md).
//
// A captured dump (capture_inbox source 'apple_notes') is interpreted with ONE LLM call
// returning person-chunks — every field optional, facts[] the payload that matters. Each
// chunk resolves through the identity cascade plus one deliberate relaxation the doctrine
// forbids for inbound traffic: a name that normalizes to EXACTLY ONE live person
// auto-attaches, because the owner wrote this note himself. Anything less certain — zero
// candidates without a name, several candidates, partial names — queues for the review
// modal (setting keys `notechunk:<hash>`, same schema-free trick as `ambiguous:*`).
//
// Facts append to person.bio under enrich.ts's MINED_MARKER so splitBio/composeBio and
// profile synthesis keep treating them as mined bullets; the user-authored head is never
// touched.

import type { Db } from "../db/db.ts";
import { resolveHandle } from "./identity.ts";
import { normalizeName, normalizePhone, normalizeEmail } from "./normalize.ts";
import { splitBio, composeBio } from "./enrich.ts";
import { addAlias } from "../connectors/common.ts";

export interface NoteChunk {
  name?: string;
  org?: string;
  role?: string;
  phone?: string;
  email?: string;
  facts: string[];
}

const CHUNK_STRING_FIELDS = ["name", "org", "role", "phone", "email"] as const;

/** Validate the model's JSON array. Junk-tolerant: bad elements drop, never throw. */
export function parseGleanChunks(raw: unknown): NoteChunk[] {
  if (!Array.isArray(raw)) return [];
  const out: NoteChunk[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const chunk: NoteChunk = { facts: [] };
    for (const f of CHUNK_STRING_FIELDS) {
      const v = rec[f];
      if (typeof v === "string" && v.trim()) chunk[f] = v.trim();
    }
    if (Array.isArray(rec.facts)) {
      chunk.facts = rec.facts.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
    }
    const empty = !chunk.name && !chunk.phone && !chunk.email && !chunk.org && !chunk.role && chunk.facts.length === 0;
    if (!empty) out.push(chunk);
  }
  return out;
}

/**
 * The owner-authored relaxation: exactly one live person whose display_name normalizes to
 * the same key → that person. Same normalization + JS filter as identity.ts's sameName scan
 * so the two stay byte-identical in behavior.
 */
export function uniqueNameMatch(db: Db, name: string): number | null {
  const key = normalizeName(name);
  if (!key) return null;
  const hits = (db.prepare("SELECT id, display_name FROM person").all() as { id: number; display_name: string }[]).filter(
    (p) => normalizeName(p.display_name) === key
  );
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * File one chunk onto a person: facts as mined bio bullets (deduped, head untouched),
 * org/role fill only when empty, phone/email become aliases, and one channel-'notes'
 * interaction records the raw chunk so the person's history shows where this came from.
 */
export function applyChunk(db: Db, chunk: NoteChunk, personId: number): void {
  const row = db.prepare("SELECT bio FROM person WHERE id = ?").get(personId) as { bio: string | null } | undefined;
  if (!row) throw new Error(`person ${personId} not found`);

  if (chunk.facts.length > 0) {
    const { head, bullets } = splitBio(row.bio);
    const seen = new Set(bullets);
    for (const f of chunk.facts) if (!seen.has(f)) { bullets.push(f); seen.add(f); }
    db.prepare("UPDATE person SET bio = ?, updated_at = datetime('now') WHERE id = ?").run(
      composeBio(head, bullets),
      personId
    );
  }
  if (chunk.org || chunk.role) {
    db.prepare(
      "UPDATE person SET org = COALESCE(org, ?), role = COALESCE(role, ?), updated_at = datetime('now') WHERE id = ?"
    ).run(chunk.org ?? null, chunk.role ?? null, personId);
  }
  const phone = normalizePhone(chunk.phone);
  if (phone) addAlias(db, personId, "phone", phone.norm, "applenotes");
  const email = normalizeEmail(chunk.email);
  if (email) addAlias(db, personId, "email", email.norm, "applenotes");

  db.prepare(
    "INSERT INTO interaction (person_id, channel, occurred_at, body_raw) VALUES (?, 'notes', datetime('now'), ?)"
  ).run(personId, chunkText(chunk));
}

/** The chunk as one readable blob for interaction history / review cards. */
export function chunkText(chunk: NoteChunk): string {
  const head = [chunk.name, chunk.role, chunk.org].filter(Boolean).join(" — ");
  return [head, ...chunk.facts].filter(Boolean).join("\n").slice(0, 2000);
}

/**
 * A brand-new person the owner wrote down: tier 2, NO 'unverified' tag — writing someone
 * into the note IS his verification (unlike connectors' auto-created unknown senders).
 */
export function createPersonFromChunk(db: Db, chunk: NoteChunk): number {
  const name = chunk.name?.trim();
  if (!name) throw new Error("cannot create a person from a nameless chunk");
  const r = db.prepare("INSERT INTO person (display_name, tier) VALUES (?, 2)").run(name);
  const id = Number(r.lastInsertRowid);
  applyChunk(db, chunk, id);
  return id;
}
```

Note: `resolveHandle` import is used in Task 4 (`gleanNotes`); if the linter flags it unused after this task, add it in Task 4 instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/pos && npx vitest run tests/crm/notesglean.test.ts`
Expected: PASS. If `normalizePhone("+1 (555) 111-2222").norm` is not `"+15551112222"`, read `main/crm/normalize.ts` and fix the TEST expectation to the module's actual E.164 form — the implementation must use `normalizePhone`, whatever its exact output.

- [ ] **Step 5: Commit**

```bash
cd ~/pos && git add main/crm/notesglean.ts tests/crm/notesglean.test.ts && git commit -m "feat(notesglean): chunk parsing, unique-name match, chunk application"
```

---

### Task 4: `gleanNotes` orchestration + note-chunk review queue

**Files:**
- Modify: `main/crm/notesglean.ts` (append)
- Test: `tests/crm/notesglean.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 exports; `LlmClient` with `.call(feature, tier, prompt, opts): Promise<LlmResult | null>` and `extractJson(text)` (main/llm/provider.ts); `contentHash` (main/crm/commitments.ts:151); `getSetting`/`setSetting` (main/db/db.ts).
- Produces (used by Tasks 5, 6):
  - `gleanNotes(db: Db, llm: LlmClient, rawText: string): Promise<{ chunks: number; applied: number; created: number; queued: number }>` — THROWS when the LLM returns null (so the capture drain retries).
  - `interface NoteChunkItem { key: string; chunk: NoteChunk; text: string; firstSeenAt: string; candidates: { id: number; display_name: string; org: string | null; role: string | null }[] }`
  - `pendingNoteChunks(db: Db): NoteChunkItem[]`
  - `resolveNoteChunk(db: Db, key: string, personId: number | "new"): { resolved: boolean; personId?: number }`
  - `dismissNoteChunk(db: Db, key: string): boolean`
  - `NOTECHUNK_PREFIX = "notechunk:"`

- [ ] **Step 1: Write the failing test** (append to `tests/crm/notesglean.test.ts`)

```ts
import {
  gleanNotes,
  pendingNoteChunks,
  resolveNoteChunk,
  dismissNoteChunk,
} from "../../main/crm/notesglean.ts";
import type { LlmClient } from "../../main/llm/provider.ts";

function fakeLlm(jsonText: string | null): LlmClient {
  return { call: async () => (jsonText === null ? null : { text: jsonText }) } as unknown as LlmClient;
}
const addPhoneAlias = (personId: number, value: string) =>
  db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, 'phone', ?)").run(personId, value);

describe("gleanNotes", () => {
  it("phone in the note attaches by identifier even when names differ", async () => {
    const id = addPerson("Abdeali Diwan");
    addPhoneAlias(id, "+15551112222");
    const r = await gleanNotes(db, fakeLlm(JSON.stringify([{ name: "Abdeali", phone: "+1 555 111 2222", facts: ["gym buddy"] }])), "dump");
    expect(r).toMatchObject({ chunks: 1, applied: 1, created: 0, queued: 0 });
    expect(person(id).bio as string).toContain("gym buddy");
  });
  it("unique name auto-attaches; new name creates tier-2 person", async () => {
    const id = addPerson("Abdeali Diwan");
    const r = await gleanNotes(
      db,
      fakeLlm(JSON.stringify([
        { name: "Abdeali Diwan", facts: ["met at gym"] },
        { name: "Brand New", facts: ["from the conf"] },
      ])),
      "dump"
    );
    expect(r).toMatchObject({ applied: 2, created: 1, queued: 0 });
    expect(person(id).bio as string).toContain("met at gym");
  });
  it("duplicate names queue for review; nameless facts queue too", async () => {
    addPerson("Jay Shah");
    addPerson("Jay Shah");
    const r = await gleanNotes(
      db,
      fakeLlm(JSON.stringify([
        { name: "Jay Shah", facts: ["owes me $20"] },
        { facts: ["someone mentioned a book: Deep Work"] },
      ])),
      "dump"
    );
    expect(r).toMatchObject({ applied: 0, created: 0, queued: 2 });
    const pending = pendingNoteChunks(db);
    expect(pending).toHaveLength(2);
    const jay = pending.find((p) => p.chunk.name === "Jay Shah")!;
    expect(jay.candidates.map((c) => c.display_name)).toEqual(["Jay Shah", "Jay Shah"]);
  });
  it("throws when the LLM is unavailable (capture drain retries)", async () => {
    await expect(gleanNotes(db, fakeLlm(null), "dump")).rejects.toThrow();
  });
});

describe("note-chunk queue", () => {
  it("resolve applies to the chosen person and clears the entry", async () => {
    addPerson("Jay Shah");
    const keep = addPerson("Jay Shah");
    await gleanNotes(db, fakeLlm(JSON.stringify([{ name: "Jay Shah", facts: ["owes me $20"] }])), "dump");
    const [item] = pendingNoteChunks(db);
    const r = resolveNoteChunk(db, item.key, keep);
    expect(r).toEqual({ resolved: true, personId: keep });
    expect(person(keep).bio as string).toContain("owes me $20");
    expect(pendingNoteChunks(db)).toHaveLength(0);
  });
  it('resolve "new" creates a person when the chunk has a name', async () => {
    addPerson("Jay Shah");
    addPerson("Jay Shah");
    await gleanNotes(db, fakeLlm(JSON.stringify([{ name: "Jay Shah", facts: ["a third jay"] }])), "dump");
    const [item] = pendingNoteChunks(db);
    const r = resolveNoteChunk(db, item.key, "new");
    expect(r.resolved).toBe(true);
    expect(person(r.personId!).bio as string).toContain("a third jay");
  });
  it("dismiss deletes; resolving a bogus key is a no-op", () => {
    expect(dismissNoteChunk(db, "notechunk:nope")).toBe(false);
    expect(resolveNoteChunk(db, "notechunk:nope", 1)).toEqual({ resolved: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/pos && npx vitest run tests/crm/notesglean.test.ts`
Expected: FAIL — `gleanNotes` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `main/crm/notesglean.ts`; add imports `extractJson, type LlmClient` from `../llm/provider.ts`, `contentHash` from `./commitments.ts`, `getSetting, setSetting` from `../db/db.ts`)

```ts
// ── the glean ────────────────────────────────────────────────────────────────

const GLEAN_PROMPT_HEAD = `You are filing the owner's raw personal note about people into his CRM.
Split the note into one JSON object per person mentioned.
Return ONLY a JSON array, no prose. Each object:
  {"name": "...", "org": "...", "role": "...", "phone": "...", "email": "...", "facts": ["..."]}
Rules:
- Every field is optional. OMIT a field rather than guess or infer it. Never invent.
- "facts" matter most: keep EVERY substantive statement about the person as one short
  fact, close to the owner's own words. Do not summarize facts away.
- Text clearly not about a specific person: one object with only "facts".
- Names: use exactly what the owner wrote (do not expand or correct spellings).

NOTE:
`;

export interface GleanResult {
  chunks: number;
  applied: number;
  created: number;
  queued: number;
}

/**
 * ONE smart-tier call for the whole dump (quota discipline — never per-chunk calls), then
 * route every chunk: identifier/corroborated match → apply; unique-name → apply; fresh
 * name → new tier-2 person; anything ambiguous or nameless → the review queue. Throws when
 * the model is unavailable so the capture drain keeps the row and retries.
 */
export async function gleanNotes(db: Db, llm: LlmClient, rawText: string): Promise<GleanResult> {
  const res = await llm.call("notesglean", "smart", GLEAN_PROMPT_HEAD + rawText.slice(0, 8000), {
    maxTokens: 2048,
  });
  if (!res) throw new Error("llm unavailable for notesglean");
  const chunks = parseGleanChunks(extractJson(res.text));
  const out: GleanResult = { chunks: chunks.length, applied: 0, created: 0, queued: 0 };

  for (const chunk of chunks) {
    const r = resolveHandle(db, {
      name: chunk.name,
      phone: chunk.phone,
      email: chunk.email,
      org: chunk.org,
    });
    if (r.status === "matched" && r.personId) {
      applyChunk(db, chunk, r.personId);
      out.applied++;
      continue;
    }
    if (r.status === "unmatched" && chunk.name) {
      const unique = uniqueNameMatch(db, chunk.name);
      if (unique) {
        applyChunk(db, chunk, unique);
        out.applied++;
      } else {
        createPersonFromChunk(db, chunk);
        out.created++;
        out.applied++;
      }
      continue;
    }
    // ambiguous, or nameless with no identifier — the user decides, nothing is dropped.
    queueNoteChunk(db, chunk, r.candidateIds ?? []);
    out.queued++;
  }
  return out;
}

// ── review queue for undecidable chunks (setting-table keys, like ambiguous:*) ──

export const NOTECHUNK_PREFIX = "notechunk:";

interface NoteChunkStored {
  chunk: NoteChunk;
  candidateIds: number[];
  firstSeenAt: string;
}

export interface NoteChunkItem {
  key: string;
  chunk: NoteChunk;
  /** chunkText() of the chunk — what the review card shows. */
  text: string;
  firstSeenAt: string;
  candidates: { id: number; display_name: string; org: string | null; role: string | null }[];
}

export function queueNoteChunk(db: Db, chunk: NoteChunk, candidateIds: number[]): string {
  const key = `${NOTECHUNK_PREFIX}${contentHash(JSON.stringify(chunk))}`;
  if (!getSetting(db, key)) {
    const stored: NoteChunkStored = { chunk, candidateIds, firstSeenAt: new Date().toISOString() };
    setSetting(db, key, JSON.stringify(stored));
  }
  return key;
}

export function pendingNoteChunks(db: Db): NoteChunkItem[] {
  const rows = db
    .prepare("SELECT key, value FROM setting WHERE key LIKE ? ORDER BY key")
    .all(`${NOTECHUNK_PREFIX}%`) as { key: string; value: string }[];
  const person = db.prepare("SELECT id, display_name, org, role FROM person WHERE id = ?");
  const out: NoteChunkItem[] = [];
  for (const r of rows) {
    let stored: NoteChunkStored;
    try {
      stored = JSON.parse(r.value) as NoteChunkStored;
    } catch {
      continue; // corrupt JSON: skip rather than blow up the queue
    }
    if (!stored?.chunk) continue;
    const chunk = parseGleanChunks([stored.chunk])[0];
    if (!chunk) continue;
    const candidates = (stored.candidateIds ?? [])
      .map((id) => person.get(id) as NoteChunkItem["candidates"][number] | undefined)
      .filter((p): p is NoteChunkItem["candidates"][number] => !!p);
    out.push({ key: r.key, chunk, text: chunkText(chunk), firstSeenAt: stored.firstSeenAt ?? "", candidates });
  }
  return out;
}

/** Apply the held chunk to the chosen person ("new" = create from it) and clear the entry. */
export function resolveNoteChunk(
  db: Db,
  key: string,
  personId: number | "new"
): { resolved: boolean; personId?: number } {
  if (!key.startsWith(NOTECHUNK_PREFIX)) throw new Error("not a note-chunk queue key");
  const raw = getSetting(db, key);
  if (!raw) return { resolved: false };
  const stored = JSON.parse(raw) as NoteChunkStored;
  const chunk = parseGleanChunks([stored.chunk])[0];
  if (!chunk) {
    dismissNoteChunk(db, key);
    return { resolved: false };
  }
  const id = personId === "new" ? createPersonFromChunk(db, chunk) : (applyChunk(db, chunk, personId), personId);
  dismissNoteChunk(db, key);
  return { resolved: true, personId: id };
}

export function dismissNoteChunk(db: Db, key: string): boolean {
  if (!key.startsWith(NOTECHUNK_PREFIX)) throw new Error("not a note-chunk queue key");
  return db.prepare("DELETE FROM setting WHERE key = ?").run(key).changes > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/pos && npx vitest run tests/crm/notesglean.test.ts`
Expected: PASS. Check `LlmOptions` in main/llm/provider.ts — if `maxTokens` is not an option field, use the field it actually has (or drop opts entirely).

- [ ] **Step 5: Commit**

```bash
cd ~/pos && git add main/crm/notesglean.ts tests/crm/notesglean.test.ts && git commit -m "feat(notesglean): glean orchestration + note-chunk review queue"
```

---

### Task 5: Review-queue payload + IPC + preload surface

**Files:**
- Modify: `main/crm/review.ts` (reviewQueue, ~line 722-745)
- Modify: `main/ipc.ts` (~line 410, review block)
- Modify: `preload/index.ts` (~line 21, review block)
- Modify: `renderer/src/pos.d.ts` (~line 104, review block)
- Test: `tests/crm/review.test.ts` (append)

**Interfaces:**
- Consumes: `pendingNoteChunks`, `resolveNoteChunk`, `dismissNoteChunk`, `NoteChunkItem` (Task 4).
- Produces: `ReviewQueue` gains `notes: NoteChunkItem[]` and `counts.notes: number` (and `counts.total` includes it); IPC channels `review.resolveNoteChunk`, `review.dismissNoteChunk`; `window.pos.review.resolveNoteChunk`, `window.pos.review.dismissNoteChunk`.

- [ ] **Step 1: Write the failing test** (append to `tests/crm/review.test.ts`, using that file's existing db setup helpers)

```ts
it("reviewQueue carries pending note chunks in payload and counts", () => {
  // queueNoteChunk import at top of file: from "../../main/crm/notesglean.ts"
  queueNoteChunk(db, { name: "Jay Shah", facts: ["owes me $20"] }, []);
  const q = reviewQueue(db);
  expect(q.notes).toHaveLength(1);
  expect(q.notes[0].chunk.name).toBe("Jay Shah");
  expect(q.counts.notes).toBe(1);
  expect(q.counts.total).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/pos && npx vitest run tests/crm/review.test.ts`
Expected: FAIL — `q.notes` undefined.

- [ ] **Step 3: Write minimal implementation**

In `main/crm/review.ts`: add import `import { pendingNoteChunks, type NoteChunkItem } from "./notesglean.ts";` and extend:

```ts
export interface ReviewQueue {
  contacts: PendingContact[];
  duplicates: DuplicateCluster[];
  ambiguous: AmbiguousItem[];
  notes: NoteChunkItem[];
  counts: { contacts: number; duplicates: number; ambiguous: number; notes: number; total: number };
}

export function reviewQueue(db: Db): ReviewQueue {
  const contacts = pendingContacts(db);
  const duplicates = duplicateClusters(db);
  const ambiguous = pendingAmbiguous(db);
  const notes = pendingNoteChunks(db);
  return {
    contacts,
    duplicates,
    ambiguous,
    notes,
    counts: {
      contacts: contacts.length,
      duplicates: duplicates.length,
      ambiguous: ambiguous.length,
      notes: notes.length,
      total: contacts.length + duplicates.length + ambiguous.length + notes.length,
    },
  };
}
```

(Keep whatever the existing `total` arithmetic looks like — just add `notes.length` to it.)

In `main/ipc.ts` next to `review.resolveAmbiguous` (add `resolveNoteChunk`, `dismissNoteChunk` to the imports from `./crm/notesglean.ts`):

```ts
h("review.resolveNoteChunk", (key: string, personId: number | "new") => resolveNoteChunk(db, key, personId));
h("review.dismissNoteChunk", (key: string) => ({ dismissed: dismissNoteChunk(db, key) }));
```

In `preload/index.ts` review block:

```ts
resolveNoteChunk: call("review.resolveNoteChunk"),
dismissNoteChunk: call("review.dismissNoteChunk"),
```

In `renderer/src/pos.d.ts` review block (match the `Call` style used there):

```ts
resolveNoteChunk: Call;
dismissNoteChunk: Call;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/pos && npx vitest run tests/crm/review.test.ts`
Expected: PASS (the new test AND every pre-existing test — the counts change must not break them; if a pre-existing test asserts the exact `counts` object shape, update it to include `notes: 0`).

- [ ] **Step 5: Commit**

```bash
cd ~/pos && git add main/crm/review.ts main/ipc.ts preload/index.ts renderer/src/pos.d.ts tests/crm/review.test.ts && git commit -m "feat(review): note-chunk section in the review queue + IPC"
```

---

### Task 6: Wire the connector + drain routing into workers

**Files:**
- Modify: `main/workers.ts` — `SyncSource` union (line 64), `CONNECTORS` map (line 92), capture-drain callback (~line 1168), tick connector block (~line 1350)
- Test: `tests/connectors/workers.test.ts` (append only if it already covers CONNECTORS dispatch; otherwise rely on typecheck + the connector's own tests)

**Interfaces:**
- Consumes: `syncAppleNotes`, `NOTE_TITLE_KEY` (Task 2); `gleanNotes` (Task 4).
- Produces: source string `"applenotes"` valid for `runSync`; capture rows with source `"apple_notes"` route to `gleanNotes` instead of `handleCommand`.

- [ ] **Step 1: Make the edits**

`SyncSource` union (line 64): add `| "applenotes"`.

`CONNECTORS` map (line 92), with `import { syncAppleNotes, NOTE_TITLE_KEY } from "./connectors/applenotes.ts";`:

```ts
  // Apple Notes people drop-box: raw dump → capture_inbox, note wiped. Gleaning happens
  // in the capture drain (crm/notesglean.ts), not here.
  applenotes: (deps) => syncAppleNotes(deps),
```

Capture-drain callback (~line 1168) — route by source:

```ts
          const cap = await drainCaptures(
            db,
            async (text, source) => {
              // People-dumps from the Apple Notes drop-box get the dedicated gleaner —
              // they are about OTHER people, not commands to the assistant.
              if (source === "apple_notes") return await gleanNotes(db, llm, text);
              const r = await handleCommand({ db, secrets, doctrineDir: resolveDoctrineDir(), llm }, text);
              return { kind: r.kind };
            },
            { healthy: llmHealth(db, secrets).ok }
          );
```

(add `import { gleanNotes } from "./crm/notesglean.ts";`)

Tick block — after the `imessageAvailable()` block (~line 1361):

```ts
      // Apple Notes people drop-box — only when the owner has named a note in Settings.
      if (process.platform === "darwin" && (getSetting(db, NOTE_TITLE_KEY) ?? "").trim()) {
        announce(await runSync(db, secrets, llm, "applenotes"));
      }
```

- [ ] **Step 2: Typecheck + run the adjacent tests**

Run: `cd ~/pos && npx tsc --noEmit && npx vitest run tests/connectors/workers.test.ts tests/connectors/applenotes.test.ts tests/capture-inbox.test.ts`
Expected: clean typecheck, all PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/pos && git add main/workers.ts && git commit -m "feat(applenotes): wire connector into sync tick + route drain by source"
```

---

### Task 7: Renderer — ReviewModal Notes tab + Settings field

**Files:**
- Modify: `renderer/src/relationships/ReviewModal.tsx`
- Modify: `renderer/src/settings/Settings.tsx` (~line 561 — mirror the `capture_self_handles` field block)

No vitest here (renderer has no test rig); the gate is `npx tsc --noEmit` plus the reviewer's read. Follow CLAUDE.md design guidelines: no decorative badges/icons, no gradients, no tiny all-caps headers — match the modal's existing tabs exactly.

- [ ] **Step 1: ReviewModal**

Add to the local types (mirroring main/crm/notesglean.ts):

```tsx
type NoteChunk = { name?: string; org?: string; role?: string; phone?: string; email?: string; facts: string[] };
type NoteChunkItem = {
  key: string;
  chunk: NoteChunk;
  text: string;
  firstSeenAt: string;
  candidates: { id: number; display_name: string; org: string | null; role: string | null }[];
};
```

Extend the payload type with `notes: NoteChunkItem[]` and `counts.notes: number`. Add a fourth tab "Notes" following exactly the pattern of the "Ambiguous" tab (its label showing `counts.notes`). Each item renders as a card:

- Header line: `chunk.name ?? "(no name)"` plus `chunk.org`/`chunk.role` when present.
- Body: the facts as plain list lines (the `text` field), plus phone/email when present.
- Actions: one button per candidate (`display_name` + org) calling `window.pos.review.resolveNoteChunk(item.key, candidate.id)`; a "New contact" button (only when `chunk.name` exists) calling `resolveNoteChunk(item.key, "new")`; a "Dismiss" button calling `window.pos.review.dismissNoteChunk(item.key)`. After any action: refetch the queue and fire the modal's existing changed-event, same as the ambiguous handlers do.

- [ ] **Step 2: Settings field**

Next to the `capture_self_handles` block in `Settings.tsx`, add an identical get/set text field:

- Label: `People note (Apple Notes)`
- Setting key: `applenotes_capture_note`
- Placeholder: `POS Inbox`
- Help line: `POS reads this note each sync, files what you wrote about people, and clears it. Leave empty to turn off.`

- [ ] **Step 3: Typecheck**

Run: `cd ~/pos && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd ~/pos && git add renderer/src/relationships/ReviewModal.tsx renderer/src/settings/Settings.tsx && git commit -m "feat(applenotes): Notes review tab + settings field"
```

---

### Task 8: Full verification

- [ ] **Step 1: Whole suite + typecheck**

Run: `cd ~/pos && npx tsc --noEmit && npm test`
Expected: typecheck clean; every test green (pre-existing failures, if any, must be shown to be pre-existing by `git stash`-ing nothing — i.e., they fail on the base commit too; do not fix unrelated failures).

- [ ] **Step 2: Spec sweep**

Re-read `docs/superpowers/specs/2026-08-13-apple-notes-capture-design.md` section by section and confirm each maps to landed code. Known deliberate deviations to confirm are documented in code comments: (a) MINED_MARKER reused instead of a new "— From notes —" marker; (b) wipe leaves the title heading, not a fully empty body.

- [ ] **Step 3: Commit any stragglers**

```bash
cd ~/pos && git status --short   # only pre-existing dirty files should remain
```
