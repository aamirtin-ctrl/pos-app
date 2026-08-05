// Google OAuth via loopback (§6): http://127.0.0.1:<random>/callback.
// Scopes cover Calendar AND Tasks (owner request 2026-08-03: blocks + tasks must
// populate on the phone through the Google ecosystem).
// Client credentials + tokens live in the secret store (Keychain-backed), never on disk.

import http from "node:http";
import crypto from "node:crypto";
import { google } from "googleapis";
import type { SecretStore } from "../secrets.ts";

export const GOOGLE_SCOPES = [
  // full calendar scope: creating the dedicated POS calendars (calendars.insert)
  // needs more than events+readonly — "Insufficient Permission" otherwise.
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  // full Gmail scope: required for IMAP XOAUTH2 (work accounts with app passwords
  // disabled connect via OAuth instead — see connectors/gmail.ts oauth accounts).
  "https://mail.google.com/",
];

/**
 * Secret name for a Google token set. No key → the original single-identity
 * secret; a key (e.g. "mail:me@corp.com") → a per-identity secret so multiple
 * Google accounts can be connected at once.
 */
export function googleTokenSecret(key?: string): string {
  return key ? `GOOGLE_OAUTH_TOKENS:${key}` : "GOOGLE_OAUTH_TOKENS";
}

export function hasGoogleCreds(secrets: SecretStore): boolean {
  return !!(secrets.get("GOOGLE_OAUTH_CLIENT_ID") && secrets.get("GOOGLE_OAUTH_CLIENT_SECRET"));
}

export function isGoogleConnected(secrets: SecretStore): boolean {
  return !!secrets.get("GOOGLE_OAUTH_TOKENS");
}

function oauthClientForSecret(secrets: SecretStore, secretName: string, redirectUri?: string) {
  const client = new google.auth.OAuth2(
    secrets.get("GOOGLE_OAUTH_CLIENT_ID") ?? undefined,
    secrets.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? undefined,
    redirectUri
  );
  const raw = secrets.get(secretName);
  if (raw) {
    try {
      client.setCredentials(JSON.parse(raw));
    } catch {
      /* re-auth needed */
    }
  }
  // persist refreshed tokens back into the keychain-backed store
  client.on("tokens", (tokens) => {
    const merged = { ...(raw ? JSON.parse(raw) : {}), ...tokens };
    secrets.set(secretName, JSON.stringify(merged));
  });
  return client;
}

export function oauthClient(secrets: SecretStore, redirectUri?: string) {
  return oauthClientForSecret(secrets, googleTokenSecret(), redirectUri);
}

/** oauthClient for a keyed identity (tokens under GOOGLE_OAUTH_TOKENS:<key>). */
export function oauthClientFor(secrets: SecretStore, key: string, redirectUri?: string) {
  return oauthClientForSecret(secrets, googleTokenSecret(key), redirectUri);
}

/**
 * Access token for a keyed identity, refreshed by googleapis when expired (any
 * refreshed token set is persisted by the client's "tokens" listener). Null when
 * the identity was never connected or the refresh fails (revoked/expired grant).
 */
export async function freshAccessToken(secrets: SecretStore, key: string): Promise<string | null> {
  if (!secrets.get(googleTokenSecret(key))) return null;
  try {
    const { token } = await oauthClientFor(secrets, key).getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}

/**
 * Full loopback flow: spins up a one-shot local server on a random port, opens the
 * consent URL in the default browser (via the callback), waits for the redirect,
 * exchanges the code, stores tokens. Resolves true on success.
 */
let cancelActive: (() => void) | null = null;

/** Cancel any in-flight loopback auth (used by Cancel/Relaunch in the UI). */
export function cancelLoopbackAuth(): void {
  cancelActive?.();
  cancelActive = null;
}

export interface LoopbackAuthResult {
  connected: boolean;
  /** On failure: "no_creds" | "timeout" | "canceled" | the OAuth error param
   *  (e.g. "access_denied", "admin_policy_enforced") | an exchange error message. */
  error?: string;
}

function runLoopbackAuthTo(
  secrets: SecretStore,
  secretName: string,
  openUrl: (url: string) => void,
  timeoutMs: number
): Promise<LoopbackAuthResult> {
  cancelLoopbackAuth(); // relaunch semantics: a new attempt supersedes a stale one
  return new Promise((resolve) => {
    if (!hasGoogleCreds(secrets)) return resolve({ connected: false, error: "no_creds" });
    const state = crypto.randomBytes(16).toString("hex");
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const client = oauthClientForSecret(secrets, secretName, redirectUri);
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: GOOGLE_SCOPES,
        state,
      });
      const timer = setTimeout(() => {
        server.close();
        resolve({ connected: false, error: "timeout" });
      }, timeoutMs);
      cancelActive = () => {
        clearTimeout(timer);
        server.close();
        resolve({ connected: false, error: "canceled" });
      };
      server.on("request", async (req, res) => {
        try {
          const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
          if (u.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          if (u.searchParams.get("state") !== state) {
            res.writeHead(400).end("state mismatch");
            return;
          }
          const code = u.searchParams.get("code");
          if (!code) {
            // Google reports refusals (user denial, Workspace admin policy) via
            // the `error` query param instead of a code — surface it typed.
            const oauthError = u.searchParams.get("error");
            res.writeHead(400).end(oauthError ? `auth failed: ${oauthError}` : "missing code");
            if (oauthError) {
              clearTimeout(timer);
              server.close();
              resolve({ connected: false, error: oauthError });
            }
            return;
          }
          const { tokens } = await client.getToken(code);
          secrets.set(secretName, JSON.stringify(tokens));
          res
            .writeHead(200, { "content-type": "text/html" })
            .end("<html><body style='font-family:sans-serif'><h3>POS is connected to Google.</h3>You can close this tab.</body></html>");
          clearTimeout(timer);
          server.close();
          resolve({ connected: true });
        } catch (e) {
          res.writeHead(500).end(`auth failed: ${(e as Error).message}`);
          clearTimeout(timer);
          server.close();
          resolve({ connected: false, error: (e as Error).message });
        }
      });
      openUrl(url);
    });
  });
}

export async function runLoopbackAuth(
  secrets: SecretStore,
  openUrl: (url: string) => void,
  timeoutMs = 5 * 60 * 1000
): Promise<boolean> {
  return (await runLoopbackAuthTo(secrets, googleTokenSecret(), openUrl, timeoutMs)).connected;
}

/**
 * Loopback flow for an additional Google identity: tokens persist under
 * GOOGLE_OAUTH_TOKENS:<key> so the default calendar connection is untouched.
 */
export function runLoopbackAuthFor(
  secrets: SecretStore,
  key: string,
  openUrl: (url: string) => void,
  timeoutMs = 5 * 60 * 1000
): Promise<LoopbackAuthResult> {
  return runLoopbackAuthTo(secrets, googleTokenSecret(key), openUrl, timeoutMs);
}
