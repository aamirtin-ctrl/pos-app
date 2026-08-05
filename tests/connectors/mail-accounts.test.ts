// Pure account-store coverage for the multi-account mail connector: presets + id
// generation on add, list round-trip through the MAIL_ACCOUNTS secret, remove, and
// legacy GMAIL_USER/GMAIL_APP_PASSWORD synthesis. Uses SecretStore against a tmpdir
// (outside Electron it falls back to plaintext-in-file — fine for tests).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../../main/secrets.ts";
import {
  listMailAccounts,
  addMailAccount,
  addOAuthMailAccount,
  removeMailAccount,
  gmailConfigured,
  mailOAuthKey,
} from "../../main/connectors/gmail.ts";
import { googleTokenSecret } from "../../main/gcal/auth.ts";

let dir: string;
let secrets: SecretStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-mail-accounts-"));
  secrets = new SecretStore(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("addMailAccount", () => {
  it("applies the gmail preset and generates a short random id", () => {
    const a = addMailAccount(secrets, { provider: "gmail", user: " a@gmail.com ", password: "pw" });
    expect(a.host).toBe("imap.gmail.com");
    expect(a.port).toBe(993);
    expect(a.user).toBe("a@gmail.com"); // trimmed
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("applies the outlook preset", () => {
    const a = addMailAccount(secrets, { provider: "outlook", user: "b@outlook.com", password: "pw" });
    expect(a.host).toBe("outlook.office365.com");
    expect(a.port).toBe(993);
  });

  it("custom imap keeps the user-provided host/port and requires a host", () => {
    const a = addMailAccount(secrets, {
      provider: "imap",
      user: "c@corp.com",
      password: "pw",
      host: "mail.corp.com",
      port: 1993,
    });
    expect(a.host).toBe("mail.corp.com");
    expect(a.port).toBe(1993);
    expect(() =>
      addMailAccount(secrets, { provider: "imap", user: "d@corp.com", password: "pw" })
    ).toThrow(/host/i);
  });

  it("generates distinct ids per account", () => {
    const a = addMailAccount(secrets, { provider: "gmail", user: "a@gmail.com", password: "pw" });
    const b = addMailAccount(secrets, { provider: "gmail", user: "b@gmail.com", password: "pw" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("listMailAccounts", () => {
  it("round-trips added accounts (including through a fresh store on the same dir)", () => {
    addMailAccount(secrets, { provider: "gmail", user: "a@gmail.com", password: "pw1" });
    addMailAccount(secrets, { provider: "outlook", user: "b@outlook.com", password: "pw2" });

    const reopened = new SecretStore(dir);
    const list = listMailAccounts(reopened);
    expect(list.map((a) => a.user)).toEqual(["a@gmail.com", "b@outlook.com"]);
    expect(list[0].password).toBe("pw1"); // full account (passwords) — IPC layer strips them
    expect(list[1].host).toBe("outlook.office365.com");
  });

  it("is empty (and gmailConfigured false) with no accounts or legacy secrets", () => {
    expect(listMailAccounts(secrets)).toEqual([]);
    expect(gmailConfigured({ secrets })).toBe(false);
  });

  it("synthesizes a legacy gmail account from GMAIL_USER/GMAIL_APP_PASSWORD", () => {
    secrets.set("GMAIL_USER", "old@gmail.com");
    secrets.set("GMAIL_APP_PASSWORD", "oldpw");
    const list = listMailAccounts(secrets);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "legacy",
      provider: "gmail",
      user: "old@gmail.com",
      password: "oldpw",
      host: "imap.gmail.com",
      port: 993,
    });
    expect(gmailConfigured({ secrets })).toBe(true);
  });

  it("does NOT synthesize legacy when an explicit account already claims that address", () => {
    secrets.set("GMAIL_USER", "Old@Gmail.com");
    secrets.set("GMAIL_APP_PASSWORD", "oldpw");
    addMailAccount(secrets, { provider: "gmail", user: "old@gmail.com", password: "newpw" });
    const list = listMailAccounts(secrets);
    expect(list).toHaveLength(1); // case-insensitive match suppresses the synthesized entry
    expect(list[0].id).not.toBe("legacy");
    expect(list[0].password).toBe("newpw");
  });
});

describe("addOAuthMailAccount", () => {
  it("applies the gmail preset, sets the oauth flag, and stores NO password", () => {
    const a = addOAuthMailAccount(secrets, " Work@Corp.com ");
    expect(a).toMatchObject({
      provider: "gmail",
      user: "Work@Corp.com",
      host: "imap.gmail.com",
      port: 993,
      auth: "oauth",
    });
    expect(a.password).toBeUndefined();
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    // nothing password-shaped in the persisted secret either
    expect(secrets.get("MAIL_ACCOUNTS")).not.toContain("password");
  });

  it("round-trips through a fresh store (auth flag survives, still no password)", () => {
    addOAuthMailAccount(secrets, "work@corp.com");
    const list = listMailAccounts(new SecretStore(dir));
    expect(list).toHaveLength(1);
    expect(list[0].auth).toBe("oauth");
    expect(list[0].password).toBeUndefined();
    expect(list[0].host).toBe("imap.gmail.com");
    expect(gmailConfigured({ secrets: new SecretStore(dir) })).toBe(true);
  });

  it("re-connecting the same address updates in place instead of duplicating", () => {
    const a = addOAuthMailAccount(secrets, "work@corp.com");
    const b = addOAuthMailAccount(secrets, "WORK@corp.com");
    expect(b.id).toBe(a.id);
    expect(listMailAccounts(secrets)).toHaveLength(1);
  });

  it("coexists with password accounts", () => {
    addMailAccount(secrets, { provider: "gmail", user: "personal@gmail.com", password: "pw" });
    addOAuthMailAccount(secrets, "work@corp.com");
    const list = listMailAccounts(secrets);
    expect(list.map((a) => [a.user, a.auth ?? "password"])).toEqual([
      ["personal@gmail.com", "password"],
      ["work@corp.com", "oauth"],
    ]);
  });
});

describe("token-key naming", () => {
  it("mailOAuthKey normalizes (trim + lowercase) so sync and connect agree", () => {
    expect(mailOAuthKey(" Work@Corp.com ")).toBe("mail:work@corp.com");
  });

  it("googleTokenSecret keys per identity and keeps the legacy default name", () => {
    expect(googleTokenSecret()).toBe("GOOGLE_OAUTH_TOKENS");
    expect(googleTokenSecret(mailOAuthKey("work@corp.com"))).toBe(
      "GOOGLE_OAUTH_TOKENS:mail:work@corp.com"
    );
  });
});

describe("removeMailAccount", () => {
  it("removes a stored account by id and leaves the others", () => {
    const a = addMailAccount(secrets, { provider: "gmail", user: "a@gmail.com", password: "pw" });
    const b = addMailAccount(secrets, { provider: "outlook", user: "b@outlook.com", password: "pw" });
    removeMailAccount(secrets, a.id);
    expect(listMailAccounts(secrets).map((x) => x.id)).toEqual([b.id]);
  });

  it("removing an oauth account also drops its Google token secret", () => {
    const a = addOAuthMailAccount(secrets, "work@corp.com");
    const tokenSecret = googleTokenSecret(mailOAuthKey("work@corp.com"));
    secrets.set(tokenSecret, JSON.stringify({ refresh_token: "r" }));
    removeMailAccount(secrets, a.id);
    expect(listMailAccounts(secrets)).toEqual([]);
    expect(secrets.get(tokenSecret)).toBeNull();
  });

  it('removing "legacy" deletes the legacy secrets so it never reappears', () => {
    secrets.set("GMAIL_USER", "old@gmail.com");
    secrets.set("GMAIL_APP_PASSWORD", "oldpw");
    removeMailAccount(secrets, "legacy");
    expect(listMailAccounts(secrets)).toEqual([]);
    expect(secrets.get("GMAIL_USER")).toBeNull();
    expect(secrets.get("GMAIL_APP_PASSWORD")).toBeNull();
  });
});
