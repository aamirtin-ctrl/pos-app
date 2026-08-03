// Secrets store. In the packaged app, values are encrypted with Electron safeStorage,
// whose key lives in the macOS Keychain — satisfying the "secrets live in Keychain"
// constraint without the unmaintained keytar. Outside Electron (tests/scripts) it
// falls back to plaintext-in-file, clearly marked, never shipped.

import fs from "node:fs";
import path from "node:path";

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

let safeStorage: SafeStorageLike | null = null;
try {
  // Only resolvable inside Electron main.
  // eslint-disable-next-line
  safeStorage = require("electron").safeStorage;
} catch {
  safeStorage = null;
}

export class SecretStore {
  private file: string;
  private cache: Record<string, { enc: boolean; v: string }> = {};

  constructor(dir: string) {
    this.file = path.join(dir, "secrets.json");
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        this.cache = {};
      }
    }
  }

  private persist() {
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
  }

  set(name: string, value: string): void {
    if (safeStorage?.isEncryptionAvailable()) {
      this.cache[name] = { enc: true, v: safeStorage.encryptString(value).toString("base64") };
    } else {
      this.cache[name] = { enc: false, v: value };
    }
    this.persist();
  }

  get(name: string): string | null {
    const e = this.cache[name];
    if (!e) return null;
    if (e.enc) {
      if (!safeStorage?.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(e.v, "base64"));
      } catch {
        return null;
      }
    }
    return e.v;
  }

  delete(name: string): void {
    delete this.cache[name];
    this.persist();
  }

  /** Names only — never values. For the settings UI. */
  list(): { name: string; encrypted: boolean }[] {
    return Object.entries(this.cache).map(([name, e]) => ({ name, encrypted: e.enc }));
  }
}

// Well-known secret names (single source of truth for settings UI + callers)
export const SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "LINKEDIN_MAIL_USER",
  "LINKEDIN_MAIL_PASSWORD",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_TOKENS",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
