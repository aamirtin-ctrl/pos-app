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

// ── scope drift: the "Push to Google does nothing" failure ───────────────────
//
// GOOGLE_SCOPES was widened to the full .../auth/calendar scope because creating the
// dedicated "POS — Planned" calendar needs calendars.insert. A token minted BEFORE that
// change still carries only calendar.events + calendar.readonly, and Google refuses the
// insert with HTTP 403 "Insufficient Permission". The refresh token keeps working, so
// nothing looks disconnected — the push just fails, forever, with a raw Google message.
//
// The two halves of the fix live here: classify the failure (needsReconsent) and read
// what the stored grant actually covers (grantedScopes / hasCalendarWriteScope) so the
// UI can say "re-authorize" and the background sweep can skip instead of spamming.

/** The one typed error string every push entry point maps a scope failure to. */
export const RECONSENT_REQUIRED = "reconsent_required";

/** Every string in an unknown error that could carry Google's reason. */
function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as {
    message?: unknown;
    errors?: unknown;
    response?: { data?: unknown };
  };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  // googleapis (Gaxios) shape: response.data.error.{message,status,errors[].reason}
  const data = e.response?.data as
    | { error?: unknown; error_description?: unknown }
    | undefined;
  if (data) {
    if (typeof data.error_description === "string") parts.push(data.error_description);
    const inner = data.error;
    if (typeof inner === "string") parts.push(inner);
    else if (inner && typeof inner === "object") {
      const o = inner as { message?: unknown; status?: unknown; errors?: unknown };
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.status === "string") parts.push(o.status);
      if (Array.isArray(o.errors)) {
        for (const x of o.errors as { reason?: unknown; message?: unknown }[]) {
          if (typeof x?.reason === "string") parts.push(x.reason);
          if (typeof x?.message === "string") parts.push(x.message);
        }
      }
    }
  }
  if (Array.isArray(e.errors)) {
    for (const x of e.errors as { reason?: unknown; message?: unknown }[]) {
      if (typeof x?.reason === "string") parts.push(x.reason);
      if (typeof x?.message === "string") parts.push(x.message);
    }
  }
  return parts.join(" ");
}

/**
 * Does this failure mean "the stored Google grant no longer covers what POS needs"?
 *
 * True for the scope-drift family only:
 *   - 403 with reason `insufficientPermissions` / message "Insufficient Permission"
 *   - "Request had insufficient authentication scopes" (the API-gateway wording)
 *   - `insufficient_scope` (OAuth bearer challenge)
 *   - `invalid_grant` (the grant itself was revoked/expired — same user action fixes it)
 *
 * Deliberately NOT true for a bare 403 (quota, calendar sharing refusals), a 404, or a
 * transport error: those are real, different problems and must not tell the owner to
 * re-authorize.
 */
export function needsReconsent(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  if (!text) return false;
  return (
    text.includes("insufficientpermissions") ||
    text.includes("insufficient permission") ||
    text.includes("insufficient authentication scopes") ||
    text.includes("insufficient_scope") ||
    text.includes("invalid_grant")
  );
}

/**
 * The scopes the STORED token set was actually granted, from the `scope` string Google
 * returns with every token/refresh response. Empty when nothing is connected, the JSON is
 * unreadable, or the stored set predates POS recording a scope string at all.
 */
export function grantedScopes(secrets: SecretStore, key?: string): string[] {
  const raw = secrets.get(googleTokenSecret(key));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { scope?: unknown };
    return typeof parsed.scope === "string" ? parsed.scope.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Can the stored grant CREATE calendars (calendars.insert), not just events?
 *
 * Matches the full `.../auth/calendar` scope exactly. A substring test would wrongly pass
 * on `.../auth/calendar.events`, which is precisely the old, insufficient grant this
 * exists to detect.
 *
 * A connected account whose token set carries NO scope string is treated as writable:
 * that is unknowable here, and refusing to push on a guess would break a working setup.
 * The 403 path (needsReconsent) classifies that case at the point of failure instead.
 */
export function hasCalendarWriteScope(secrets: SecretStore, key?: string): boolean {
  const raw = secrets.get(googleTokenSecret(key));
  if (!raw) return false; // nothing connected at all
  const scopes = grantedScopes(secrets, key);
  if (scopes.length === 0) return true; // unknowable — let the API answer
  return scopes.some((s) => /(^|\/)auth\/calendar$/.test(s.trim()));
}

export interface GoogleScopeStatus {
  connected: boolean;
  hasCreds: boolean;
  /** Connected AND the grant covers calendar writes (calendars.insert). */
  canWrite: boolean;
}

/** One read for the UI: connected / creds present / grant wide enough to push. */
export function googleScopeStatus(secrets: SecretStore): GoogleScopeStatus {
  const connected = isGoogleConnected(secrets);
  return {
    connected,
    hasCreds: hasGoogleCreds(secrets),
    canWrite: connected && hasCalendarWriteScope(secrets),
  };
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
