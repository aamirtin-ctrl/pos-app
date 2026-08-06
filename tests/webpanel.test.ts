// The URL policy behind the docked web panels. main/webpanel.ts keeps every
// electron touch behind a lazy require() precisely so this file can exercise the
// decision logic without a browser: what the panel is allowed to display is the
// part that actually enforces the owner's "Instagram DMs, nothing else" ask, and
// it should be testable in milliseconds.

import { describe, it, expect } from "vitest";
import {
  SERVICES,
  SERVICE_IDS,
  getService,
  isAllowedUrl,
  decideNavigation,
} from "../main/webpanel.ts";

describe("service registry", () => {
  it("carries the three web-only messaging services", () => {
    expect(SERVICE_IDS.sort()).toEqual(["instagram", "linkedin", "snapchat"]);
  });

  it("gives every service an https home and its own persistent partition", () => {
    const partitions = new Set<string>();
    for (const id of SERVICE_IDS) {
      const s = SERVICES[id];
      expect(s.id).toBe(id);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.url.startsWith("https://")).toBe(true);
      // persist: — a login must survive a restart, which is the whole reason these
      // are docked panels rather than a link to Safari.
      expect(s.partition.startsWith("persist:")).toBe(true);
      partitions.add(s.partition);
    }
    // Distinct partitions: no service can read another's cookies, and none of them
    // share the app's default session.
    expect(partitions.size).toBe(SERVICE_IDS.length);
  });

  it("scopes Instagram — and only Instagram — with a path allowlist", () => {
    expect(SERVICES.instagram.allowPathPrefixes).toBeDefined();
    expect(SERVICES.instagram.allowPathPrefixes).toContain("/direct");
    expect(SERVICES.snapchat.allowPathPrefixes).toBeUndefined();
    expect(SERVICES.linkedin.allowPathPrefixes).toBeUndefined();
  });

  it("resolves ids and refuses unknown ones", () => {
    expect(getService("instagram")).toBe(SERVICES.instagram);
    expect(getService("nope")).toBeNull();
    // not a prototype lookup
    expect(getService("toString")).toBeNull();
    expect(getService("constructor")).toBeNull();
  });
});

describe("isAllowedUrl — Instagram is held to Direct", () => {
  const ig = SERVICES.instagram;

  it("allows the DM inbox and individual threads", () => {
    expect(isAllowedUrl(ig, "https://www.instagram.com/direct/inbox/")).toBe(true);
    expect(isAllowedUrl(ig, "https://www.instagram.com/direct/t/1234567890/")).toBe(true);
  });

  it("blocks the rest of the product", () => {
    expect(isAllowedUrl(ig, "https://www.instagram.com/explore/")).toBe(false);
    expect(isAllowedUrl(ig, "https://www.instagram.com/reels/")).toBe(false);
    expect(isAllowedUrl(ig, "https://www.instagram.com/")).toBe(false); // the feed
    expect(isAllowedUrl(ig, "https://www.instagram.com/p/Cxyz123/")).toBe(false);
    expect(isAllowedUrl(ig, "https://www.instagram.com/someone/")).toBe(false);
  });

  it("keeps the sign-in path open", () => {
    // Verified against the live site: an unauthenticated GET of /direct/inbox/
    // answers 302 → /accounts/login/?next=…%2Fdirect%2Finbox%2F
    expect(
      isAllowedUrl(
        ig,
        "https://www.instagram.com/accounts/login/?next=https%3A%2F%2Fwww.instagram.com%2Fdirect%2Finbox%2F"
      )
    ).toBe(true);
    expect(isAllowedUrl(ig, "https://www.instagram.com/accounts/login/two_factor?next=%2F")).toBe(true);
    // The post-login "Save your login info?" interstitial — without this the very
    // first sign-in bounces before it finishes.
    expect(isAllowedUrl(ig, "https://www.instagram.com/accounts/onetap/?next=%2F")).toBe(true);
    expect(isAllowedUrl(ig, "https://www.instagram.com/challenge/action/12345/")).toBe(true);
  });

  it("blocks another host outright, allowlisted path or not", () => {
    expect(isAllowedUrl(ig, "https://example.com/direct/inbox/")).toBe(false);
    expect(isAllowedUrl(ig, "https://instagram.evil.com/direct/inbox/")).toBe(false);
    // a lookalike that merely *contains* the domain
    expect(isAllowedUrl(ig, "https://www.instagram.com.evil.test/direct/")).toBe(false);
  });
});

describe("isAllowedUrl — services with no allowlist", () => {
  const snap = SERVICES.snapchat;

  it("allows any path on the service's own domain", () => {
    expect(isAllowedUrl(snap, "https://web.snapchat.com/")).toBe(true);
    expect(isAllowedUrl(snap, "https://web.snapchat.com/web/chat/abc123")).toBe(true);
    expect(isAllowedUrl(snap, "https://web.snapchat.com/settings")).toBe(true);
    // Snapchat's sign-in lives on a sibling subdomain, so same-site rather than
    // same-host is what keeps login working.
    expect(isAllowedUrl(snap, "https://accounts.snapchat.com/accounts/v2/login")).toBe(true);
  });

  it("blocks off-host navigation", () => {
    expect(isAllowedUrl(snap, "https://example.com/")).toBe(false);
    expect(isAllowedUrl(snap, "https://www.instagram.com/direct/inbox/")).toBe(false);
    expect(isAllowedUrl(snap, "https://snapchat.com.evil.test/")).toBe(false);
  });

  it("treats LinkedIn messaging the same way", () => {
    expect(isAllowedUrl(SERVICES.linkedin, "https://www.linkedin.com/messaging/")).toBe(true);
    expect(isAllowedUrl(SERVICES.linkedin, "https://www.linkedin.com/feed/")).toBe(true);
    expect(isAllowedUrl(SERVICES.linkedin, "https://www.instagram.com/")).toBe(false);
  });
});

describe("decideNavigation — bounce vs. hand-off", () => {
  it("bounces an off-limits path on the service's own site, rather than shelling out", () => {
    // Opening the Instagram feed in Safari instead would defeat the point.
    expect(decideNavigation(SERVICES.instagram, "https://www.instagram.com/explore/")).toBe("bounce");
  });

  it("hands a genuinely external link to the system browser", () => {
    expect(decideNavigation(SERVICES.instagram, "https://help.example.com/article")).toBe("external");
    expect(decideNavigation(SERVICES.snapchat, "https://www.google.com/")).toBe("external");
  });

  it("refuses non-web schemes instead of handing them to the OS", () => {
    // shell.openExternal on a page-chosen scheme is a launcher for local apps.
    for (const url of [
      "file:///etc/passwd",
      "mailto:someone@example.com",
      "itms-apps://apps.apple.com/app/id123",
      "javascript:alert(1)",
      "not a url at all",
    ]) {
      expect(decideNavigation(SERVICES.instagram, url)).toBe("bounce");
    }
  });

  it("allows plain http on the same site (a redirect-to-https hop)", () => {
    expect(decideNavigation(SERVICES.snapchat, "http://web.snapchat.com/")).toBe("allow");
  });
});
