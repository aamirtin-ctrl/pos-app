// A tapback is a reaction, never a message.
//
// iMessage delivers reactions as ordinary messages whose TEXT describes them — `Liked "…"`,
// `You loved "…"`, `Reacted with a sticker to "…"`. The connector does not store chat.db's
// associated_message_type, so the text shape is all there is to go on.
//
// It is never new intent: it reacts to a message already ingested and already reasoned about.
// Treating one as content produces nonsense downstream, and it did — two of his open
// commitments on 2026-08-08 read "EURO 26 🇮🇹🇨🇭🇪🇸 — Reacted with a sticker to …", out of 831
// tapback interactions in the database.
//
// Two causes. The pattern predated the sticker reaction iOS added later, and it existed
// TWICE: messaging.ts had the fuller version, crm/followups.ts a weaker hand-rolled copy
// missing "you …" and the removal forms. They drifted, and neither knew about stickers.

import { describe, it, expect } from "vitest";
import { isTapback } from "../main/connectors/common.ts";
import { isTapback as fromMessaging } from "../main/messaging.ts";

describe("isTapback", () => {
  it("catches every reaction wording Apple ships", () => {
    for (const t of [
      'Liked "see you at 6"',
      'Loved "see you at 6"',
      'Laughed at "see you at 6"',
      'Emphasized "see you at 6"',
      'Emphasised "see you at 6"',
      'Questioned "see you at 6"',
      'Disliked "see you at 6"',
      'Removed a like from "see you at 6"',
      'Removed a heart from "see you at 6"',
    ]) {
      expect(isTapback(t), t).toBe(true);
    }
  });

  it("catches the FIRST-PERSON forms", () => {
    expect(isTapback('You liked "see you at 6"')).toBe(true);
    expect(isTapback('You loved "see you at 6"')).toBe(true);
    expect(isTapback('You laughed at "see you at 6"')).toBe(true);
  });

  it("catches sticker and image reactions — the ones that got through", () => {
    // His real row: "EURO 26 … Reacted with a sticker to 'I will be gone for the evening'".
    expect(isTapback('Reacted with a sticker to "I will be gone for the evening"')).toBe(true);
    expect(isTapback('You reacted with a sticker to "I will be gone"')).toBe(true);
    expect(isTapback('Reacted with an image to "dinner?"')).toBe(true);
  });

  it("handles curly quotes, which is what iOS actually sends", () => {
    expect(isTapback('Loved “see you at 6”')).toBe(true);
    expect(isTapback("Liked ‘see you at 6’")).toBe(true);
  });

  it("does NOT swallow real messages that merely start with those words", () => {
    for (const t of [
      "Liked your idea, let's do Tuesday",
      "Loved the deck — can you send the final?",
      "Questioned whether we need the meeting at all",
      "I reacted badly to that, sorry",
      "Reacted with surprise when I saw the invoice",
      "Wanna come to library with me tmw am",
      "",
    ]) {
      expect(isTapback(t), t).toBe(false);
    }
  });

  it("is null-safe", () => {
    expect(isTapback(null)).toBe(false);
    expect(isTapback(undefined)).toBe(false);
  });

  it("messaging.ts exposes the SAME detector, not a second copy", () => {
    expect(fromMessaging).toBe(isTapback);
  });
});
