import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../main/db/db.ts";
import type { LlmClient } from "../../main/llm/provider.ts";
import {
  newsSentence,
  fallbackSentences,
  draftReconnect,
  markReachedOut,
  openUrlFor,
  reconnectTargets,
  sentences,
  wrapEmail,
} from "../../main/crm/reconnect-draft.ts";
import { reconnectDue, refreshNextTouch } from "../../main/crm/reconnect.ts";

let dir: string;
let db: Db;

function addPerson(name: string, extra: Record<string, unknown> = {}): number {
  const cols = ["display_name", "tier", "last_contact_at", ...Object.keys(extra)];
  const vals = [name, 1, "2026-03-01T00:00:00Z", ...Object.values(extra)];
  const r = db.prepare(`INSERT INTO person (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
  return Number(r.lastInsertRowid);
}
const alias = (pid: number, kind: string, value: string) =>
  db.prepare("INSERT INTO alias (person_id, kind, value) VALUES (?, ?, ?)").run(pid, kind, value);
const fakeLlm = (text: string | null, seen: string[] = []) =>
  ({ call: async (_f: string, _t: string, prompt: string) => { seen.push(prompt); return text === null ? null : { text }; } }) as unknown as LlmClient;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-rdraft-"));
  db = openDb(path.join(dir, "pos.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reconnect drafts", () => {
  it("picks the last-used reachable channel, else text > email > linkedin", async () => {
    const a = addPerson("Sam Lee");
    alias(a, "phone", "+15551234567");
    alias(a, "email", "sam@example.com");
    db.prepare("INSERT INTO interaction (person_id, channel, direction, occurred_at) VALUES (?, 'gmail', 'inbound', '2026-03-01T00:00:00Z')").run(a);
    expect((await draftReconnect(db, null, a)).channel).toBe("email");
    const b = addPerson("Kim");
    alias(b, "email", "kim@example.com");
    expect((await draftReconnect(db, null, b)).channel).toBe("email");
    const c = addPerson("Nobody Handles");
    const d = await draftReconnect(db, null, c);
    expect(d.channel).toBe("linkedin");
    expect(openUrlFor("linkedin", d.targets, d.name, d.body, null)).toContain("search/results/people/?keywords=Nobody%20Handles");
  });

  it("fallback is exactly three sentences, greets by first name, uses only worklog news", async () => {
    const id = addPerson("Priya Patel");
    db.prepare("INSERT INTO worklog (happened_at, title, source) VALUES ('2026-06-01 00:00:00', 'Started a summer internship at Tesla', 'manual')").run();
    const d = await draftReconnect(db, null, id, "text");
    expect(d.usedLlm).toBe(false);
    expect(sentences(d.body)).toHaveLength(3);
    expect(d.body).toMatch(/^Hey Priya!/);
    expect(d.body).toContain("started a summer internship at Tesla");
  });

  it("uses the model's message, trims to three sentences, keeps email framing", async () => {
    const id = addPerson("Alex Kim");
    alias(id, "email", "alex@example.com");
    const seen: string[] = [];
    const llm = fakeLlm(JSON.stringify({
      message: "Hey Alex, how have you been? I just wrapped my first quarter at Stanford. Would love to grab coffee soon! Extra sentence.",
      subject: "Long time!",
    }), seen);
    const d = await draftReconnect(db, llm, id, "email");
    expect(d.usedLlm).toBe(true);
    expect(d.subject).toBe("Long time!");
    expect(d.body.startsWith("Hi Alex,\n\n")).toBe(true);
    expect(d.body).not.toContain("Extra sentence");
    expect(d.body).toMatch(/Best,\nAamir$/);
    expect(seen[0]).toContain("EXACTLY 3 sentences");
    expect(seen[0]).toContain("never invent");
  });

  it("degrades to the fallback when the model returns junk or nothing", async () => {
    const id = addPerson("Jo");
    for (const llm of [fakeLlm("not json"), fakeLlm(null), fakeLlm('{"message":"Hi."}')]) {
      const d = await draftReconnect(db, llm, id, "text");
      expect(d.usedLlm).toBe(false);
      expect(sentences(d.body)).toHaveLength(3);
    }
  });

  it("builds prefilled sms: and mailto: URLs from handles on file only", () => {
    const id = addPerson("Sam Lee");
    alias(id, "imessage_handle", "+1 (555) 123-4567");
    alias(id, "email", "sam+x@example.com");
    alias(id, "linkedin", "https://www.linkedin.com/in/SamLee/?trk=x");
    const t = reconnectTargets(db, id);
    expect(t.linkedin).toBe("https://www.linkedin.com/in/samlee");
    expect(openUrlFor("text", t, "Sam", "Hi & bye?", null)).toBe("sms:+15551234567&body=Hi%20%26%20bye%3F");
    expect(openUrlFor("email", t, "Sam", "a\nb", "Hey there")).toBe("mailto:sam%2Bx@example.com?subject=Hey%20there&body=a%0Ab");
    expect(() => openUrlFor("text", { text: null, email: null, linkedin: null }, "x", "y", null)).toThrow(/no phone/);
  });

  it("wrapEmail substitutes the voice greeting and drops a doubled opener", () => {
    expect(wrapEmail("Dana", "Hey Dana! How are you? News. Coffee?", { category: "email", tone: "", greeting: "Hey <name> -", signoff: "Cheers, A", avgWords: 0, notes: [] }))
      .toBe("Hey Dana -\n\nHow are you? News. Coffee?\n\nCheers,\nA");
  });

  it("'I sent it' logs a touch and takes them off the Reconnect list", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const id = addPerson("Overdue Olivia");
    refreshNextTouch(db);
    expect(reconnectDue(db, now).map((r) => r.id)).toContain(id);
    markReachedOut(db, id, "text", "Hey Olivia!", now);
    refreshNextTouch(db);
    expect(reconnectDue(db, now).map((r) => r.id)).not.toContain(id);
    const row = db.prepare("SELECT channel, direction, body_summary FROM interaction WHERE person_id = ?").get(id);
    expect(row).toEqual({ channel: "manual", direction: "outbound", body_summary: null });
  });
});

describe("my news (his one-line update)", () => {
  it("becomes sentence two of the fallback and keeps the note at three sentences", () => {
    const s = fallbackSentences("Sam", [], "Just moved to SF and started at a new startup. Also got a dog");
    expect(s).toHaveLength(3);
    expect(s[1]).toBe("Just moved to SF and started at a new startup.");
  });
  it("adds closing punctuation and ignores blank input", () => {
    expect(newsSentence("Started a new job")).toBe("Started a new job.");
    expect(newsSentence("   ")).toBeNull();
  });
});
