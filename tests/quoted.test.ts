import { describe, it, expect } from "vitest";
import { splitQuoted } from "../renderer/src/inbox/quoted.ts";

describe("splitQuoted", () => {
  it("plain text has no quoted tail", () => {
    expect(splitQuoted("Sounds good, see you Tuesday.\n\nJane")).toEqual({
      visible: "Sounds good, see you Tuesday.\n\nJane",
      quoted: null,
    });
  });

  it("Gmail single-line 'On … wrote:'", () => {
    const r = splitQuoted(
      "Yes that works.\n\nOn Tue, Sep 9, 2026 at 3:12 PM Jane <jane@x.com> wrote:\n> Are you free Tuesday?\n> Jane"
    );
    expect(r.visible).toBe("Yes that works.");
    expect(r.quoted).toBe("On Tue, Sep 9, 2026 at 3:12 PM Jane <jane@x.com> wrote:\n> Are you free Tuesday?\n> Jane");
  });

  it("Gmail wrapped two-line 'On …' / '… wrote:'", () => {
    const r = splitQuoted("Yes.\n\nOn Tue, Sep 9, 2026 at 3:12 PM Jane Doe\n<jane@x.com> wrote:\n> hi");
    expect(r.visible).toBe("Yes.");
    expect(r.quoted!.startsWith("On Tue, Sep 9, 2026 at 3:12 PM Jane Doe\n<jane@x.com> wrote:")).toBe(true);
  });

  it("Outlook 'From: / Sent: / To: / Subject:' block", () => {
    const r = splitQuoted("Thanks!\n\nFrom: Jane <jane@x.com>\nSent: Tuesday, September 9, 2026 3:12 PM\nTo: Me\nSubject: Tuesday\n\nAre you free?");
    expect(r.visible).toBe("Thanks!");
    expect(r.quoted!.startsWith("From: Jane")).toBe(true);
  });

  it("-----Original Message----- and ---------- Forwarded message --------- rules", () => {
    expect(splitQuoted("ok\n-----Original Message-----\nFrom: x").visible).toBe("ok");
    expect(splitQuoted("fyi\n\n---------- Forwarded message ---------\nFrom: x").quoted!.startsWith("----------")).toBe(true);
  });

  it("a run of '>' lines is quoted; a single stray '>' line is not", () => {
    expect(splitQuoted("agreed\n\n> first\n> second").visible).toBe("agreed");
    expect(splitQuoted("x > y is true\n> just one line here\nmore text").quoted).toBeNull();
  });

  it("a 'From:' line without header lines after it is body text, not a quote", () => {
    expect(splitQuoted("From: the top of the hill you can see everything.\nIt was lovely.").quoted).toBeNull();
  });

  it("an all-quote message stays visible with no toggle", () => {
    const r = splitQuoted("On Tue Jane wrote:\n> forwarded to you");
    expect(r.visible).toBe("On Tue Jane wrote:\n> forwarded to you");
    expect(r.quoted).toBeNull();
  });
});
