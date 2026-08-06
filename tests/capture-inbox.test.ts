// Nothing he says is allowed to evaporate.
//
// Owner ask 2026-08-06: "the system should be able to take info from my emails to myself,
// sparkle button, and personal texts and all that should run through a tasks/calendar
// event/personal info gleaning pipeline… that should be the working pipeline."
//
// The pipeline existed at all three entry points. What it lacked was DURABILITY: each one
// classified with the model and acted in a single pass, so a provider outage meant the input
// was read, misrouted or ignored, and then gone. His Gemini quota ran out at 18:18 that day
// and everything he typed into the sparkle box afterwards produced no task, no event, no note
// and no error he could see — the only evidence it happened is that he remembered typing it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../main/db/db.ts";
import {
  recordCapture,
  markCaptureDone,
  markCaptureFailed,
  pendingCaptures,
  pendingCaptureCount,
  drainCaptures,
  MAX_CAPTURE_ATTEMPTS,
} from "../main/capture-inbox.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-capture-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (id: number) => db.prepare("SELECT * FROM capture_inbox WHERE id = ?").get(id) as any;

describe("recordCapture", () => {
  it("keeps what he actually said, verbatim", () => {
    const id = recordCapture(db, "sparkle", "  two hours on the Stanford advising thing  ")!;
    expect(row(id).raw_text).toBe("two hours on the Stanford advising thing");
    expect(row(id).source).toBe("sparkle");
    expect(row(id).processed_at).toBeNull();
  });

  it("records from every surface that can carry an instruction", () => {
    for (const src of ["sparkle", "self_email", "imessage", "alexa"] as const) {
      expect(recordCapture(db, src, `from ${src}`)).not.toBeNull();
    }
    expect(pendingCaptureCount(db)).toBe(4);
  });

  it("does not record an empty line — there is nothing to lose", () => {
    expect(recordCapture(db, "sparkle", "   ")).toBeNull();
    expect(pendingCaptureCount(db)).toBe(0);
  });
});

describe("the queue", () => {
  it("holds an input whose interpretation failed", () => {
    const id = recordCapture(db, "sparkle", "something the model could not reach")!;
    markCaptureFailed(db, id, "429 quota exceeded");
    expect(pendingCaptureCount(db)).toBe(1);
    expect(row(id).attempts).toBe(1);
    expect(row(id).error).toMatch(/quota/);
  });

  it("releases it once it has been understood", () => {
    const id = recordCapture(db, "sparkle", "plan my day")!;
    markCaptureDone(db, id, { kind: "plan" });
    expect(pendingCaptureCount(db)).toBe(0);
    expect(row(id).processed_at).toBeTruthy();
    expect(JSON.parse(row(id).result)).toEqual({ kind: "plan" });
  });

  it("gives up on a line it can never parse, but keeps it findable", () => {
    const id = recordCapture(db, "sparkle", "unparseable")!;
    for (let i = 0; i < MAX_CAPTURE_ATTEMPTS; i++) markCaptureFailed(db, id, "nope");
    expect(pendingCaptureCount(db)).toBe(0); // stops costing model calls
    expect(row(id).processed_at).toBeTruthy();
    expect(row(id).error).toBe("nope"); // …but the row and its reason survive
  });

  it("returns oldest first — he said them in an order", () => {
    const a = recordCapture(db, "sparkle", "first")!;
    const b = recordCapture(db, "sparkle", "second")!;
    expect(pendingCaptures(db).map((r) => r.id)).toEqual([a, b]);
  });
});

describe("drainCaptures", () => {
  it("re-runs the pipeline over everything said while the model was down", async () => {
    recordCapture(db, "sparkle", "two hours on advising this week");
    recordCapture(db, "self_email", "remember school starts Sept 22");
    const seen: string[] = [];

    const res = await drainCaptures(db, async (text) => { seen.push(text); return { kind: "plan" }; }, { healthy: true });
    expect(res).toMatchObject({ processed: 2, failed: 0 });
    expect(seen).toEqual(["two hours on advising this week", "remember school starts Sept 22"]);
    expect(pendingCaptureCount(db)).toBe(0);
  });

  // The failure that made this module necessary: retrying against a provider that is still
  // down would burn every row's attempts on an outage that has nothing to do with the text.
  it("refuses to run while the model is still unavailable", async () => {
    const id = recordCapture(db, "sparkle", "anything")!;
    const res = await drainCaptures(db, async () => ({}), { healthy: false });
    expect(res.skipped).toBe("llm_unavailable");
    expect(row(id).attempts).toBe(0); // untouched, not burned
    expect(pendingCaptureCount(db)).toBe(1);
  });

  it("keeps a row that fails and moves on to the next", async () => {
    recordCapture(db, "sparkle", "bad");
    recordCapture(db, "sparkle", "good");
    const res = await drainCaptures(
      db,
      async (text) => { if (text === "bad") throw new Error("boom"); return { kind: "note" }; },
      { healthy: true }
    );
    expect(res).toMatchObject({ processed: 1, failed: 1 });
    expect(pendingCaptureCount(db)).toBe(1); // the bad one is still queued for a retry
  });

  it("says so when there is nothing waiting", async () => {
    expect(await drainCaptures(db, async () => ({}), { healthy: true })).toMatchObject({ skipped: "empty" });
  });

  it("caps how much one drain does, so a backlog cannot monopolise a tick", async () => {
    for (let i = 0; i < 8; i++) recordCapture(db, "sparkle", `line ${i}`);
    const res = await drainCaptures(db, async () => ({ kind: "note" }), { healthy: true, limit: 3 });
    expect(res.processed).toBe(3);
    expect(pendingCaptureCount(db)).toBe(5);
  });
});
