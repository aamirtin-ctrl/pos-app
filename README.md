# POS — Personal Operating System

Local-first macOS app: Relationships (personal CRM) + Calendar Engine + Messaging (stub),
one SQLite spine. Built per `BUILD_SPEC.md`; audit of the predecessor app in
`../PersonalCRM2/AUDIT.md`.

## Run (dev)

```bash
npm install
npm run dev        # vite + electron (rebuilds native modules for Electron ABI)
```

## Test

```bash
npm run rebuild:node   # once, if you've run the app (switches better-sqlite3 back to node ABI)
npm test               # vitest — engine gate tests, CRM, connectors, db
```

## Package

```bash
npm run package    # release/mac-arm64/POS.app (unsigned)
```

## First-run notes

- DB self-creates at `~/Library/Application Support/pos/pos.db`. No external installs.
- Doctrine seeds at `~/Library/Application Support/pos/doctrine.yaml` (wake 07:30) — edit in
  Settings; hard constraints are never auto-modified.
- API keys (Gemini today, Anthropic when you have one) are entered in Settings and stored via
  macOS Keychain-backed encryption. Never in `.env`.
- Google: create an OAuth *Desktop* client in Google Cloud Console, paste client id/secret in
  Settings → Connect. Plans push to the **POS — Planned** calendar; tasks/commitments to the
  **POS** Google Tasks list (both sync to your phone). Push is always explicit.
- iMessage sync needs Full Disk Access (Settings has a shortcut to the pane).
- Legacy data: `npm run migrate:from-postgres` (one-shot, from the old PersonalCRM2 Postgres).
