// Google OAuth via loopback (§6): http://127.0.0.1:<random>/callback.
// Scopes cover Calendar AND Tasks (owner request 2026-08-03: blocks + tasks must
// populate on the phone through the Google ecosystem).
// Client credentials + tokens live in the secret store (Keychain-backed), never on disk.

import http from "node:http";
import crypto from "node:crypto";
import { google } from "googleapis";
import type { SecretStore } from "../secrets.ts";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
];

export function hasGoogleCreds(secrets: SecretStore): boolean {
  return !!(secrets.get("GOOGLE_OAUTH_CLIENT_ID") && secrets.get("GOOGLE_OAUTH_CLIENT_SECRET"));
}

export function isGoogleConnected(secrets: SecretStore): boolean {
  return !!secrets.get("GOOGLE_OAUTH_TOKENS");
}

export function oauthClient(secrets: SecretStore, redirectUri?: string) {
  const client = new google.auth.OAuth2(
    secrets.get("GOOGLE_OAUTH_CLIENT_ID") ?? undefined,
    secrets.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? undefined,
    redirectUri
  );
  const raw = secrets.get("GOOGLE_OAUTH_TOKENS");
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
    secrets.set("GOOGLE_OAUTH_TOKENS", JSON.stringify(merged));
  });
  return client;
}

/**
 * Full loopback flow: spins up a one-shot local server on a random port, opens the
 * consent URL in the default browser (via the callback), waits for the redirect,
 * exchanges the code, stores tokens. Resolves true on success.
 */
export function runLoopbackAuth(
  secrets: SecretStore,
  openUrl: (url: string) => void,
  timeoutMs = 5 * 60 * 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!hasGoogleCreds(secrets)) return resolve(false);
    const state = crypto.randomBytes(16).toString("hex");
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const client = oauthClient(secrets, redirectUri);
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: GOOGLE_SCOPES,
        state,
      });
      const timer = setTimeout(() => {
        server.close();
        resolve(false);
      }, timeoutMs);
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
            res.writeHead(400).end("missing code");
            return;
          }
          const { tokens } = await client.getToken(code);
          secrets.set("GOOGLE_OAUTH_TOKENS", JSON.stringify(tokens));
          res
            .writeHead(200, { "content-type": "text/html" })
            .end("<html><body style='font-family:sans-serif'><h3>POS is connected to Google.</h3>You can close this tab.</body></html>");
          clearTimeout(timer);
          server.close();
          resolve(true);
        } catch (e) {
          res.writeHead(500).end(`auth failed: ${(e as Error).message}`);
          clearTimeout(timer);
          server.close();
          resolve(false);
        }
      });
      openUrl(url);
    });
  });
}
