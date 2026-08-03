// Classification unit tests for the LinkedIn-email connector — ported from
// PersonalCRM2 lib/linkedin-email.test.ts (node:test → vitest). Pure functions only:
// subject/sender parsing → event kind + name/role/company/profile extraction. No network.
import { describe, it, expect } from "vitest";
import {
  isLinkedInSender,
  classifyLinkedInEmail,
  nameFromSlug,
  eventLabel,
} from "../../main/connectors/linkedin-email.ts";

describe("isLinkedInSender", () => {
  it("matches linkedin domains only", () => {
    expect(isLinkedInSender("invitations@linkedin.com")).toBe(true);
    expect(isLinkedInSender("messaging-digest@e.linkedin.com")).toBe(true);
    expect(isLinkedInSender("Jane <notifications-noreply@linkedin.com>".match(/<(.+)>/)![1])).toBe(true);
    expect(isLinkedInSender("hacker@linkedin.com.evil.com")).toBe(false);
    expect(isLinkedInSender("someone@gmail.com")).toBe(false);
    expect(isLinkedInSender(null)).toBe(false);
  });
});

describe("classifyLinkedInEmail", () => {
  it("invitation received → invite_received with name + profile + headline", () => {
    const ev = classifyLinkedInEmail({
      subject: "Jane Doe would like to connect on LinkedIn",
      fromName: "Jane Doe via LinkedIn",
      text: "Jane Doe\nSoftware Engineer at Acme Corp\nhttps://www.linkedin.com/comm/in/jane-doe-12345?trk=eml\nAccept",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("invite_received");
    expect(ev!.person.name).toBe("Jane Doe");
    expect(ev!.person.profileUrl).toBe("https://www.linkedin.com/in/jane-doe-12345");
    expect(ev!.person.role).toBe("Software Engineer");
    expect(ev!.person.company).toBe("Acme Corp");
  });

  it("invitation accepted → invite_accepted, name from subject", () => {
    const ev = classifyLinkedInEmail({
      subject: "Congrats! John Smith accepted your invitation.",
      fromName: "LinkedIn",
      text: "See what John is up to. https://www.linkedin.com/in/john-smith-9/",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("invite_accepted");
    expect(ev!.person.name).toBe("John Smith");
    expect(ev!.person.profileUrl).toBe("https://www.linkedin.com/in/john-smith-9");
  });

  it("name falls back to From display name", () => {
    const ev = classifyLinkedInEmail({
      subject: "You have an invitation",
      fromName: "Maria Garcia via LinkedIn",
      text: "Maria wants to connect with you. https://www.linkedin.com/in/maria-g",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("invite_received");
    expect(ev!.person.name).toBe("Maria Garcia");
  });

  it("non-invite LinkedIn mail is ignored", () => {
    expect(
      classifyLinkedInEmail({
        subject: "You have 5 new notifications this week",
        fromName: "LinkedIn",
        text: "Your network has been busy. See jobs you may like.",
        html: null,
      })
    ).toBeNull();
    expect(
      classifyLinkedInEmail({
        subject: "Aamir, you appeared in 9 searches this week",
        fromName: "LinkedIn",
        text: "https://www.linkedin.com/in/someone",
        html: null,
      })
    ).toBeNull();
  });

  it("you're now connected phrasing", () => {
    const ev = classifyLinkedInEmail({
      subject: "You're now connected with Priya Patel",
      fromName: "LinkedIn",
      text: "https://www.linkedin.com/comm/in/priya-patel-007?midToken=x",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("invite_accepted");
    expect(ev!.person.name).toBe("Priya Patel");
    expect(ev!.person.profileUrl).toBe("https://www.linkedin.com/in/priya-patel-007");
  });

  it("message notification (subject match) → message_notification with name", () => {
    const ev = classifyLinkedInEmail({
      subject: "Sam Lee just messaged you",
      fromName: "Sam Lee via LinkedIn",
      text: "Hi — great meeting you last week. https://www.linkedin.com/comm/in/sam-lee-3?trk=x",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("message_notification");
    expect(ev!.person.name).toBe("Sam Lee");
    expect(ev!.person.profileUrl).toBe("https://www.linkedin.com/in/sam-lee-3");
  });

  it("message wording in the BODY alone does not classify as a message", () => {
    // Digests mention "sent you a message" in the body — subject-only matching keeps them out.
    expect(
      classifyLinkedInEmail({
        subject: "Your weekly digest",
        fromName: "LinkedIn",
        text: "Sam Lee sent you a message. Also: 12 jobs for you.",
        html: null,
      })
    ).toBeNull();
  });

  it("invite phrasing wins over message phrasing", () => {
    const ev = classifyLinkedInEmail({
      subject: "Ana Ruiz sent you a message",
      fromName: "LinkedIn",
      text: "Ana Ruiz would like to connect. https://www.linkedin.com/in/ana-ruiz",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.kind).toBe("invite_received");
  });

  it("cleans 'via LinkedIn' / emoji and rejects bare 'LinkedIn' as a name", () => {
    const ev = classifyLinkedInEmail({
      subject: "You have an invitation",
      fromName: "LinkedIn",
      text: "someone wants to connect https://www.linkedin.com/in/some-one",
      html: null,
    });
    expect(ev).toBeTruthy();
    expect(ev!.person.name).toBeNull(); // "LinkedIn" is not a person name
    expect(ev!.person.profileUrl).toBe("https://www.linkedin.com/in/some-one");
  });

  it("returns null with neither a name nor a profile URL", () => {
    expect(
      classifyLinkedInEmail({
        subject: "You have an invitation to connect",
        fromName: "LinkedIn",
        text: "Somebody wants to grow your network.",
        html: null,
      })
    ).toBeNull();
  });
});

describe("nameFromSlug", () => {
  it("humanizes a slug, stripping trailing hash/digits", () => {
    expect(nameFromSlug("https://www.linkedin.com/in/jane-doe-1a2b3c4d")).toBe("Jane Doe");
    expect(nameFromSlug("https://www.linkedin.com/in/john-smith-9")).toBe("John Smith");
    expect(nameFromSlug(null)).toBeNull();
    expect(nameFromSlug("https://www.linkedin.com/feed/")).toBeNull();
  });
});

describe("eventLabel", () => {
  it("maps kinds to timeline subjects", () => {
    expect(eventLabel("invite_received")).toBe("LinkedIn — sent you an invite");
    expect(eventLabel("invite_accepted")).toBe("LinkedIn — accepted your invite");
    expect(eventLabel("message_notification")).toBe("LinkedIn — sent you a message");
  });
});
