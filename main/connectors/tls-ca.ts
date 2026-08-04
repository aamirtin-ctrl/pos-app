// macOS system trust store → Node TLS.
//
// Electron ships its own CA bundle, which does NOT include roots the *user's Mac*
// trusts — notably TLS-inspecting antivirus (Avast/Kaspersky/ESET Mail Shield) and
// corporate MITM proxies, which re-sign IMAP connections with their own CA. Without
// this, imapflow fails with "unable to verify the first certificate" even though the
// connection is fine from the OS's point of view.
//
// We keep certificate verification ON and simply extend the trust list with whatever
// macOS already trusts. Never disable rejectUnauthorized.

import { execFileSync } from "node:child_process";

const KEYCHAINS = [
  "/Library/Keychains/System.keychain",            // admin-installed roots (AV, MDM, corporate)
  "/System/Library/Keychains/SystemRootCertificates.keychain", // Apple's shipped roots
];

let cached: string[] | null = null;

/** PEM-encoded certs macOS trusts. Cached; safe to call per connection. */
export function systemCaCerts(): string[] {
  if (cached) return cached;
  const out: string[] = [];
  for (const kc of KEYCHAINS) {
    try {
      const pem = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-p", kc], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const m of pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
        out.push(m[0]);
      }
    } catch {
      // keychain unreadable (unlikely) — fall through with whatever we have
    }
  }
  cached = out;
  return out;
}

/**
 * TLS options for imapflow: Node's built-in roots PLUS the system's.
 * Passing `ca` replaces the default list, so we can't only pass system roots —
 * we append them to Node's bundled set.
 */
export function imapTlsOptions(): { ca: string[] } {
  const tls = require("node:tls") as typeof import("node:tls");
  const builtin = (tls.rootCertificates ?? []) as readonly string[];
  return { ca: [...builtin, ...systemCaCerts()] };
}
