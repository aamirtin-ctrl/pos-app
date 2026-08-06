// Apple Screen Time (macOS Knowledge store) — Mac-only, LOCAL, READ-ONLY.
//
// Why this file exists: the learning loop (engine/learning.ts) was fed entirely by the
// owner self-reporting whether each block happened and how focused he felt. macOS already
// records objective app usage in the Knowledge store, and POS already holds Full Disk
// Access, so adherence and the energy-curve recalibration can be grounded in what the Mac
// actually did instead of what he remembers doing.
//
// Safety contract (identical to connectors/imessage.ts, deliberately):
//   - Never open the live ~/Library/Application Support/Knowledge/knowledgeC.db writable.
//   - Copy db + -wal + -shm to a tmpdir, open the COPY read-only (better-sqlite3
//     readonly + PRAGMA query_only), delete the tmpdir afterwards.
//   - EPERM/EACCES/"authorization denied" surface as the typed 'full_disk_access' error.
//
// SCHEMA (knowledgeC.db, CoreData-backed; stable across macOS 10.13 → 15):
//   ZOBJECT
//     ZSTREAMNAME   TEXT  — the event stream, e.g. '/app/usage', '/app/inFocus',
//                            '/display/isBacklit', '/app/activity', '/device/isLocked'
//     ZVALUESTRING  TEXT  — for /app/usage: the bundle id ("com.apple.dt.Xcode")
//     ZVALUEINTEGER INT   — for /display/isBacklit: 1 = display on
//     ZSTARTDATE    REAL  — Apple absolute time: SECONDS since 2001-01-01T00:00:00Z
//     ZENDDATE      REAL  — same epoch (chat.db, by contrast, stores NANOSECONDS)
//     ZSOURCE       INT   — FK → ZSOURCE.Z_PK
//   ZSOURCE
//     ZDEVICEID     TEXT  — NULL/'' for events this Mac generated; a device UUID for
//                            rows synced in from an iPhone/iPad over iCloud. We keep
//                            local rows only unless includeRemoteDevices is set, so an
//                            iPhone doomscroll never scores a Mac deep-work block.
//
// Everything here degrades rather than throws on schema drift: columns and tables are
// probed with PRAGMA before use, and an unknown bundle id is 'neutral', not an error.

import { createRequire } from "node:module";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db/db.ts";
import { captureOutcomes, AUTO_OUTCOME_NOTE_SUFFIX, type OutcomeEntry } from "./engine/learning.ts";

// ── minimal sqlite surface (same shape the iMessage connector uses) ──────────────
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

// ── constants ───────────────────────────────────────────────────────────────────
const APPLE_EPOCH_MS = 978_307_200_000; // 2001-01-01T00:00:00Z in Unix ms

export const DEFAULT_KNOWLEDGE_DB = join(
  homedir(), "Library", "Application Support", "Knowledge", "knowledgeC.db"
);

export const APP_USAGE_STREAM = "/app/usage";
export const IN_FOCUS_STREAM = "/app/inFocus";
export const BACKLIT_STREAM = "/display/isBacklit";

/** Same-app rows separated by no more than this are one sitting, not two. */
export const MERGE_GAP_SECONDS = 60;

/** Below this share of a block's minutes, "he wasn't at the machine" is the honest read. */
export const MIN_COVERAGE_PCT = 20;

// ── Apple absolute time ─────────────────────────────────────────────────────────
/** Apple absolute time (SECONDS since 2001-01-01) → JS Date. */
export function appleSecondsToDate(sec: number): Date {
  return new Date(APPLE_EPOCH_MS + sec * 1000);
}
/** JS Date → Apple absolute time (SECONDS since 2001-01-01). */
export function dateToAppleSeconds(d: Date): number {
  return (d.getTime() - APPLE_EPOCH_MS) / 1000;
}

// ── typed failure ───────────────────────────────────────────────────────────────
export type ScreenTimeErrorKind = "full_disk_access" | "unavailable";

export class ScreenTimeError extends Error {
  constructor(public readonly kind: ScreenTimeErrorKind, message: string) {
    super(message);
    this.name = "ScreenTimeError";
  }
}

/** EPERM/EACCES/SQLite "authorization denied" → the Full Disk Access failure mode. */
function isFdaError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "EPERM" || err?.code === "EACCES") return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("authorization denied") || msg.includes("operation not permitted");
}

function asScreenTimeError(e: unknown): ScreenTimeError {
  if (e instanceof ScreenTimeError) return e;
  const msg = (e as Error)?.message ?? String(e);
  return new ScreenTimeError(isFdaError(e) ? "full_disk_access" : "unavailable", msg);
}

export interface ScreenTimeStatus {
  ok: boolean;
  error?: ScreenTimeErrorKind;
  detail?: string;
}

/**
 * Cheap precheck for the scheduler/UI. Note that macOS lets an unauthorized process
 * stat() the file but not open() it, so existsSync alone is not proof — we actually
 * open it for reading and close it again.
 */
export function screenTimeAvailable(dbPath: string = DEFAULT_KNOWLEDGE_DB): ScreenTimeStatus {
  if (!existsSync(dbPath)) {
    return { ok: false, error: "unavailable", detail: `${dbPath} not found` };
  }
  try {
    const fd = openSync(dbPath, "r");
    closeSync(fd);
    return { ok: true };
  } catch (e) {
    const err = asScreenTimeError(e);
    return { ok: false, error: err.kind, detail: err.message };
  }
}

// ── categories ──────────────────────────────────────────────────────────────────
export type UsageCategory = "focus" | "communication" | "distraction" | "neutral";

/**
 * Default bundle-id → category table. Exported so the owner can override it (an entry
 * added here wins over the prefix rules below). Anything unknown is 'neutral' — never
 * 'distraction', because guessing badly here would silently falsify adherence.
 */
export const CATEGORY_MAP: Record<string, UsageCategory> = {
  // ── focus: editors, IDEs, terminals, documents, reading ──
  "com.apple.dt.Xcode": "focus",
  "com.microsoft.VSCode": "focus",
  "com.microsoft.VSCodeInsiders": "focus",
  "com.todesktop.230313mzl4w4u92": "focus", // Cursor
  "dev.zed.Zed": "focus",
  "com.sublimetext.4": "focus",
  "com.jetbrains.intellij": "focus",
  "com.jetbrains.WebStorm": "focus",
  "com.jetbrains.pycharm": "focus",
  "com.apple.Terminal": "focus",
  "com.googlecode.iterm2": "focus",
  "dev.warp.Warp-Stable": "focus",
  "co.zeit.hyper": "focus",
  "com.github.GitHubClient": "focus",
  "com.figma.Desktop": "focus",
  "com.microsoft.Word": "focus",
  "com.microsoft.Excel": "focus",
  "com.microsoft.Powerpoint": "focus",
  "com.microsoft.onenote.mac": "focus",
  "com.apple.iWork.Pages": "focus",
  "com.apple.iWork.Numbers": "focus",
  "com.apple.iWork.Keynote": "focus",
  "notion.id": "focus",
  "com.electron.realm": "focus",
  "com.apple.Preview": "focus",
  "com.apple.Notes": "focus",
  "md.obsidian": "focus",
  "com.readdle.PDFExpert-Mac": "focus",
  "com.anthropic.claudefordesktop": "focus",
  "com.openai.chat": "focus",

  // ── communication ──
  "com.apple.mail": "communication",
  "com.microsoft.Outlook": "communication",
  "com.readdle.smartemail-Mac": "communication",
  "com.superhuman.electron": "communication",
  "com.tinyspeck.slackmacgap": "communication",
  "com.apple.iChat": "communication", // Messages.app
  "com.apple.MobileSMS": "communication",
  "us.zoom.xos": "communication",
  "com.microsoft.teams": "communication",
  "com.microsoft.teams2": "communication",
  "com.google.Chrome.app.meet": "communication",
  "com.hnc.Discord.helper": "communication",
  "com.apple.FaceTime": "communication",
  "net.whatsapp.WhatsApp": "communication",
  "com.loom.desktop": "communication",

  // ── distraction: social, video, games ──
  "com.burbn.instagram": "distraction",
  "com.zhiliaoapp.musically": "distraction", // TikTok
  "com.google.ios.youtube": "distraction",
  "com.apple.TV": "distraction",
  "com.netflix.Netflix": "distraction",
  "com.atebits.Tweetie2": "distraction", // X / Twitter
  "com.twitter.twitter-mac": "distraction",
  "com.reddit.Reddit": "distraction",
  "com.hnc.Discord": "distraction",
  "com.spotify.client": "distraction",
  "com.valvesoftware.steam": "distraction",
  "com.riotgames.LeagueofLegends": "distraction",
  "com.apple.Photos": "distraction",
  "tv.twitch.desktop": "distraction",

  // ── neutral: the OS getting out of the way ──
  "com.apple.finder": "neutral",
  "com.apple.systempreferences": "neutral",
  "com.apple.SystemPreferences": "neutral",
  "com.apple.Safari": "neutral", // a browser is whatever is in the tab — refuse to guess
  "com.google.Chrome": "neutral",
  "com.brave.Browser": "neutral",
  "org.mozilla.firefox": "neutral",
  "company.thebrowser.Browser": "neutral", // Arc
  "com.apple.ActivityMonitor": "neutral",
  "com.apple.calculator": "neutral",
  "com.apple.iCal": "neutral",
  "com.apple.reminders": "neutral",
  "com.apple.loginwindow": "neutral",
  "com.apple.Spotlight": "neutral",
};

/** Coarse fallbacks for bundle ids the table doesn't name, keyed by prefix. */
const CATEGORY_PREFIXES: [string, UsageCategory][] = [
  ["com.jetbrains.", "focus"],
  ["com.microsoft.VSCode", "focus"],
  ["com.apple.dt.", "focus"],
  ["com.apple.iWork.", "focus"],
];

export function categoryFor(bundleId: string): UsageCategory {
  const direct = CATEGORY_MAP[bundleId];
  if (direct) return direct;
  for (const [prefix, cat] of CATEGORY_PREFIXES) {
    if (bundleId.startsWith(prefix)) return cat;
  }
  return "neutral";
}

/** Human names for the note line; anything else falls back to the last dotted segment. */
const APP_NAMES: Record<string, string> = {
  "com.apple.dt.Xcode": "Xcode",
  "com.microsoft.VSCode": "VS Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.googlecode.iterm2": "iTerm",
  "com.apple.Terminal": "Terminal",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.apple.mail": "Mail",
  "com.apple.iChat": "Messages",
  "com.apple.MobileSMS": "Messages",
  "us.zoom.xos": "Zoom",
  "com.microsoft.Outlook": "Outlook",
  "notion.id": "Notion",
  "com.apple.Safari": "Safari",
  "com.google.Chrome": "Chrome",
  "com.apple.finder": "Finder",
  "com.burbn.instagram": "Instagram",
  "com.zhiliaoapp.musically": "TikTok",
  "com.netflix.Netflix": "Netflix",
  "com.hnc.Discord": "Discord",
  "com.reddit.Reddit": "Reddit",
  "com.spotify.client": "Spotify",
  "com.figma.Desktop": "Figma",
  "com.anthropic.claudefordesktop": "Claude",
};

export function appNameFor(bundleId: string): string {
  const known = APP_NAMES[bundleId];
  if (known) return known;
  const last = bundleId.split(".").filter(Boolean).pop() ?? bundleId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// ── read model ──────────────────────────────────────────────────────────────────
export interface UsageSpan {
  bundleId: string;
  appName: string;
  /** Minutes from local midnight of the range's START day (can exceed 1440 if the range spans days). */
  startMin: number;
  endMin: number;
  seconds: number;
}

export interface AwakeSpan {
  startMin: number;
  endMin: number;
  seconds: number;
}

export interface UsageSnapshot {
  usage: UsageSpan[];
  /** '/display/isBacklit' == 1 spans — evidence the Mac was actually awake. */
  awake: AwakeSpan[];
  /** False when the store has no /display/isBacklit stream at all (then awake is []). */
  backlitAvailable: boolean;
  rangeStartISO: string;
  rangeEndISO: string;
  /** Local-midnight anchor the *Min fields are measured from, as epoch ms. */
  anchorMs: number;
}

export interface ReadOptions {
  dbPath?: string;
  /** Include rows synced in from an iPhone/iPad. Default false — this Mac only. */
  includeRemoteDevices?: boolean;
  /** Override the usage stream (e.g. IN_FOCUS_STREAM). Default '/app/usage'. */
  stream?: string;
}

// ── copy-first open ─────────────────────────────────────────────────────────────
interface OpenedCopy {
  db: SqliteDatabase;
  dispose(): void;
}

/**
 * Copy knowledgeC.db (+ -wal/-shm) to a private tmpdir and open the COPY read-only.
 * The live file is never opened writable and never mutated.
 */
function openKnowledgeCopy(srcPath: string): OpenedCopy {
  if (!existsSync(srcPath)) {
    throw new ScreenTimeError("unavailable", `${srcPath} not found`);
  }
  // Prove readability before we start making directories — an unauthorized process can
  // stat() this file happily and only fail at open().
  try {
    const fd = openSync(srcPath, "r");
    closeSync(fd);
  } catch (e) {
    throw asScreenTimeError(e);
  }

  const workDir = mkdtempSync(join(tmpdir(), "pos-knowledge-"));
  const workPath = join(workDir, "knowledgeC.db");
  try {
    copyFileSync(srcPath, workPath);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(srcPath + ext)) {
        try {
          copyFileSync(srcPath + ext, workPath + ext);
        } catch {
          /* a missing/locked sidecar is not fatal — the main file is still consistent */
        }
      }
    }
    const BetterSqlite = req("better-sqlite3");
    const db = new BetterSqlite(workPath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    db.exec("PRAGMA query_only = ON;");
    return {
      db,
      dispose() {
        try {
          db.close();
        } finally {
          rmSync(workDir, { recursive: true, force: true });
        }
      },
    };
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw asScreenTimeError(e);
  }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return !!row;
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

// ── span extraction ─────────────────────────────────────────────────────────────
interface RawSpan {
  value: string | null;
  int: number | null;
  startSec: number;
  endSec: number;
  device: string | null;
}

function readRawSpans(
  db: SqliteDatabase,
  stream: string,
  startSec: number,
  endSec: number
): RawSpan[] {
  if (!tableExists(db, "ZOBJECT")) {
    throw new ScreenTimeError("unavailable", "ZOBJECT missing — not a knowledgeC store");
  }
  const objCols = columns(db, "ZOBJECT");
  const joinSource = objCols.has("ZSOURCE") && tableExists(db, "ZSOURCE") && columns(db, "ZSOURCE").has("ZDEVICEID");

  const sql = joinSource
    ? `SELECT o.ZVALUESTRING AS value, o.ZVALUEINTEGER AS int, o.ZSTARTDATE AS s, o.ZENDDATE AS e,
              src.ZDEVICEID AS device
         FROM ZOBJECT o LEFT JOIN ZSOURCE src ON src.Z_PK = o.ZSOURCE
        WHERE o.ZSTREAMNAME = ? AND o.ZENDDATE > ? AND o.ZSTARTDATE < ?
        ORDER BY o.ZSTARTDATE ASC`
    : `SELECT ZVALUESTRING AS value, ZVALUEINTEGER AS int, ZSTARTDATE AS s, ZENDDATE AS e,
              NULL AS device
         FROM ZOBJECT
        WHERE ZSTREAMNAME = ? AND ZENDDATE > ? AND ZSTARTDATE < ?
        ORDER BY ZSTARTDATE ASC`;

  const rows = db.prepare(sql).all(stream, startSec, endSec) as {
    value: string | null;
    int: number | null;
    s: number | null;
    e: number | null;
    device: string | null;
  }[];

  return rows
    .filter((r) => typeof r.s === "number" && typeof r.e === "number" && (r.e as number) > (r.s as number))
    .map((r) => ({
      value: r.value,
      int: r.int,
      startSec: r.s as number,
      endSec: r.e as number,
      device: r.device,
    }));
}

const isLocalDevice = (device: string | null): boolean => device === null || device.trim() === "";

/**
 * Keep this Mac's own rows. If the filter would empty a non-empty result set, the
 * ZDEVICEID convention on this machine isn't what we assume — keep everything rather
 * than silently reporting "no usage" (and say so in the log).
 */
function filterLocal(rows: RawSpan[], includeRemote: boolean): RawSpan[] {
  if (includeRemote) return rows;
  const local = rows.filter((r) => isLocalDevice(r.device));
  if (local.length === 0 && rows.length > 0) {
    console.log("screentime: no rows had a NULL ZSOURCE.ZDEVICEID — keeping all devices for this read");
    return rows;
  }
  return local;
}

/** Clamp to [startMs, endMs] and merge same-key spans that touch (or overlap). */
function clampAndMerge(
  rows: { key: string; startMs: number; endMs: number }[],
  startMs: number,
  endMs: number
): { key: string; startMs: number; endMs: number }[] {
  const clamped = rows
    .map((r) => ({
      key: r.key,
      startMs: Math.max(r.startMs, startMs),
      endMs: Math.min(r.endMs, endMs),
    }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => (a.key === b.key ? a.startMs - b.startMs : a.key < b.key ? -1 : 1));

  const out: { key: string; startMs: number; endMs: number }[] = [];
  for (const r of clamped) {
    const prev = out[out.length - 1];
    if (prev && prev.key === r.key && r.startMs <= prev.endMs + MERGE_GAP_SECONDS * 1000) {
      prev.endMs = Math.max(prev.endMs, r.endMs);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Local midnight of the day the given instant falls on. */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * One copy-first read of everything the range needs: app usage spans plus the
 * backlit (display-on) spans that tell us the Mac was awake at all.
 */
export function readSnapshot(startISO: string, endISO: string, opts: ReadOptions = {}): UsageSnapshot {
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ScreenTimeError("unavailable", `unparseable range ${startISO}..${endISO}`);
  }
  const anchorMs = localMidnight(start).getTime();
  const startMs = start.getTime();
  const endMs = end.getTime();
  const toMin = (ms: number) => round2((ms - anchorMs) / 60000);

  const opened = openKnowledgeCopy(opts.dbPath ?? DEFAULT_KNOWLEDGE_DB);
  try {
    const startSec = dateToAppleSeconds(start);
    const endSec = dateToAppleSeconds(end);

    // ── app usage ──
    const usageRows = filterLocal(
      readRawSpans(opened.db, opts.stream ?? APP_USAGE_STREAM, startSec, endSec),
      !!opts.includeRemoteDevices
    ).filter((r) => !!r.value && r.value.trim() !== "");

    const mergedUsage = clampAndMerge(
      usageRows.map((r) => ({
        key: r.value as string,
        startMs: appleSecondsToDate(r.startSec).getTime(),
        endMs: appleSecondsToDate(r.endSec).getTime(),
      })),
      startMs,
      endMs
    );

    const usage: UsageSpan[] = mergedUsage
      .map((r) => ({
        bundleId: r.key,
        appName: appNameFor(r.key),
        startMin: toMin(r.startMs),
        endMin: toMin(r.endMs),
        seconds: Math.round((r.endMs - r.startMs) / 1000),
      }))
      .sort((a, b) => a.startMin - b.startMin || a.bundleId.localeCompare(b.bundleId));

    // ── display backlit (Mac awake) ──
    let awake: AwakeSpan[] = [];
    let backlitAvailable = false;
    try {
      const rows = filterLocal(
        readRawSpans(opened.db, BACKLIT_STREAM, startSec, endSec),
        !!opts.includeRemoteDevices
      );
      backlitAvailable = true;
      const merged = clampAndMerge(
        rows
          .filter((r) => r.int === null || r.int === 1) // ZVALUEINTEGER 1 = display on
          .map((r) => ({
            key: "backlit",
            startMs: appleSecondsToDate(r.startSec).getTime(),
            endMs: appleSecondsToDate(r.endSec).getTime(),
          })),
        startMs,
        endMs
      );
      awake = merged.map((r) => ({
        startMin: toMin(r.startMs),
        endMin: toMin(r.endMs),
        seconds: Math.round((r.endMs - r.startMs) / 1000),
      }));
    } catch {
      backlitAvailable = false; // stream absent on this macOS build — usage alone decides
    }

    return { usage, awake, backlitAvailable, rangeStartISO: startISO, rangeEndISO: endISO, anchorMs };
  } finally {
    opened.dispose();
  }
}

/** App usage overlapping [startISO, endISO), clamped to the range and merged per app. */
export function usageForRange(startISO: string, endISO: string, opts: ReadOptions = {}): UsageSpan[] {
  return readSnapshot(startISO, endISO, opts).usage;
}

// ── aggregation ─────────────────────────────────────────────────────────────────
export interface CategoryShare {
  category: UsageCategory;
  seconds: number;
  /** Share of total recorded usage seconds, 0-100, one decimal. */
  pct: number;
}

export interface AppShare {
  bundleId: string;
  appName: string;
  seconds: number;
  pct: number;
}

export interface UsageAggregate {
  totalSeconds: number;
  categories: CategoryShare[]; // all four, seconds desc
  byCategory: Record<UsageCategory, number>;
  dominant: UsageCategory | null;
  topApps: AppShare[]; // 3 by seconds
}

const ALL_CATEGORIES: UsageCategory[] = ["focus", "communication", "distraction", "neutral"];

export function aggregateUsage(spans: UsageSpan[]): UsageAggregate {
  const byCategory: Record<UsageCategory, number> = {
    focus: 0, communication: 0, distraction: 0, neutral: 0,
  };
  const byApp = new Map<string, number>();
  let totalSeconds = 0;
  for (const s of spans) {
    byCategory[categoryFor(s.bundleId)] += s.seconds;
    byApp.set(s.bundleId, (byApp.get(s.bundleId) ?? 0) + s.seconds);
    totalSeconds += s.seconds;
  }
  const pct = (n: number) => (totalSeconds > 0 ? Math.round((n / totalSeconds) * 1000) / 10 : 0);

  const categories = ALL_CATEGORIES.map((category) => ({
    category,
    seconds: byCategory[category],
    pct: pct(byCategory[category]),
  })).sort((a, b) => b.seconds - a.seconds);

  const topApps = [...byApp.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([bundleId, seconds]) => ({ bundleId, appName: appNameFor(bundleId), seconds, pct: pct(seconds) }));

  const dominant = categories[0] && categories[0].seconds > 0 ? categories[0].category : null;
  return { totalSeconds, categories, byCategory, dominant, topApps };
}

/** Seconds of [aStart,aEnd) covered by any of the given spans (already union-merged). */
function overlapSeconds(spans: { startMin: number; endMin: number }[], startMin: number, endMin: number): number {
  let sec = 0;
  for (const s of spans) {
    const lo = Math.max(s.startMin, startMin);
    const hi = Math.min(s.endMin, endMin);
    if (hi > lo) sec += (hi - lo) * 60;
  }
  return Math.round(sec);
}

// ── per-block report ────────────────────────────────────────────────────────────
export interface BlockUsageReport extends UsageAggregate {
  blockId: number;
  blockType: string;
  title: string | null;
  startsAt: string;
  endsAt: string;
  blockMinutes: number;
  /** Recorded usage seconds as a share of the block's length, 0-100 (can exceed 100 only if clocks skew). */
  coveragePct: number;
  /** Display-on seconds inside the block; null when the store has no backlit stream. */
  awakeSeconds: number | null;
  spans: UsageSpan[];
}

interface BlockRow {
  id: number;
  block_type: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
}

/** Compute the report for one already-read snapshot slice. */
function reportForBlock(block: BlockRow, snap: UsageSnapshot): BlockUsageReport {
  const toMin = (iso: string) => round2((new Date(iso).getTime() - snap.anchorMs) / 60000);
  const bStart = toMin(block.starts_at);
  const bEnd = toMin(block.ends_at);
  const blockMinutes = Math.max(0, round2(bEnd - bStart));

  const spans: UsageSpan[] = [];
  for (const s of snap.usage) {
    const lo = Math.max(s.startMin, bStart);
    const hi = Math.min(s.endMin, bEnd);
    if (hi <= lo) continue;
    spans.push({
      bundleId: s.bundleId,
      appName: s.appName,
      startMin: round2(lo),
      endMin: round2(hi),
      seconds: Math.round((hi - lo) * 60),
    });
  }

  const agg = aggregateUsage(spans);
  const blockSeconds = blockMinutes * 60;
  return {
    ...agg,
    blockId: block.id,
    blockType: block.block_type,
    title: block.title,
    startsAt: block.starts_at,
    endsAt: block.ends_at,
    blockMinutes,
    coveragePct: blockSeconds > 0 ? Math.round((agg.totalSeconds / blockSeconds) * 1000) / 10 : 0,
    awakeSeconds: snap.backlitAvailable ? overlapSeconds(snap.awake, bStart, bEnd) : null,
    spans,
  };
}

export interface BlockUsageOptions extends ReadOptions {
  /** Inject a snapshot instead of reading knowledgeC.db (tests, batch reads). */
  snapshot?: UsageSnapshot;
}

/** Screen Time usage overlapping one block's window, aggregated by category. */
export function blockUsage(db: Db, blockId: number, opts: BlockUsageOptions = {}): BlockUsageReport {
  const block = db
    .prepare("SELECT id, block_type, title, starts_at, ends_at FROM block WHERE id = ?")
    .get(blockId) as BlockRow | undefined;
  if (!block) throw new ScreenTimeError("unavailable", `block ${blockId} not found`);
  const snap = opts.snapshot ?? readSnapshot(block.starts_at, block.ends_at, opts);
  return reportForBlock(block, snap);
}

// ── auto-capture ────────────────────────────────────────────────────────────────
/**
 * What a block type is supposed to look like in app usage. Block types absent from
 * this table (gym, errands, sleep, anything physical) are never auto-captured — the
 * Mac has nothing to say about them and inventing a verdict would be a lie.
 */
export const INTENT_CATEGORY: Record<string, UsageCategory | "any"> = {
  deep_work: "focus",
  focused_work: "focus",
  admin: "focus",
  comms: "communication",
  meeting: "any",
};

/** focus-share (% of recorded usage) → perceived_focus proxy, 1-5. */
export function focusProxy(focusPct: number): number {
  if (focusPct >= 80) return 5;
  if (focusPct >= 60) return 4;
  if (focusPct >= 40) return 3;
  if (focusPct >= 20) return 2;
  return 1;
}

export type AutoSkipReason =
  | "manual_outcome"       // the owner already answered — his answer always wins
  | "unsupported_type"     // nothing on a Mac would evidence this block
  | "no_evidence";         // barely any usage AND no proof the Mac was even awake

export interface AutoCaptureRow {
  blockId: number;
  blockType: string;
  completed: boolean;
  perceivedFocus: number;
  note: string;
  coveragePct: number;
  dominant: UsageCategory | null;
}

export interface AutoCaptureResult {
  date: string;
  captured: number;
  rows: AutoCaptureRow[];
  skipped: { blockId: number; blockType: string; reason: AutoSkipReason }[];
  error?: ScreenTimeErrorKind;
  detail?: string;
}

/** "62% Xcode, 18% Slack — auto from Screen Time" */
function evidenceNote(report: BlockUsageReport): string {
  const parts = report.topApps
    .filter((a) => a.pct >= 1)
    .map((a) => `${Math.round(a.pct)}% ${a.appName}`);
  const body = parts.length > 0 ? parts.join(", ") : "no app usage recorded";
  return `${body} — ${AUTO_OUTCOME_NOTE_SUFFIX}`;
}

export interface AutoCaptureOptions extends BlockUsageOptions {
  /** Skip the copy-first read entirely and use these spans (tests). */
  snapshot?: UsageSnapshot;
}

/**
 * Derive block outcomes for `dateISO` from Screen Time and write them through
 * captureOutcomes(). Only blocks of an ACCEPTED plan, non-anchor, and — critically —
 * only blocks with NO existing block_outcome row: an outcome the owner recorded by
 * hand is never touched, overwritten, or duplicated.
 *
 * actual_start_at/actual_end_at are deliberately left NULL. Those feed
 * recomputeMultipliers (the planning-fallacy coefficient), and app-usage boundaries are
 * not the same thing as "when he started and stopped working" — that number stays
 * owner-sourced. Only `completed` and the `perceived_focus` proxy come from the Mac.
 */
export function autoCaptureOutcomes(db: Db, dateISO: string, opts: AutoCaptureOptions = {}): AutoCaptureResult {
  const result: AutoCaptureResult = { date: dateISO, captured: 0, rows: [], skipped: [] };

  // The NOT EXISTS clause IS the never-overwrite guarantee (mirrors planner.outcomesNeeded).
  const blocks = db
    .prepare(
      `SELECT b.id, b.block_type, b.title, b.starts_at, b.ends_at
         FROM block b JOIN plan p ON p.id = b.plan_id
        WHERE p.plan_date = ? AND p.accepted_at IS NOT NULL AND b.is_anchor = 0
          AND b.block_type NOT IN ('break','transition','meal')
          AND NOT EXISTS (SELECT 1 FROM block_outcome o WHERE o.block_id = b.id)
        ORDER BY b.starts_at`
    )
    .all(dateISO) as BlockRow[];

  const candidates = blocks.filter((b) => {
    if (INTENT_CATEGORY[b.block_type] === undefined) {
      result.skipped.push({ blockId: b.id, blockType: b.block_type, reason: "unsupported_type" });
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return result;

  // ONE copy-first read covering every candidate block (a late block may run past
  // midnight — anchoring on the plan date's local midnight keeps the minute math
  // consistent while the read still reaches the last block's end).
  const rangeStart = candidates.reduce(
    (lo, b) => (b.starts_at < lo ? b.starts_at : lo),
    candidates[0].starts_at
  );
  const rangeEnd = candidates.reduce(
    (hi, b) => (b.ends_at > hi ? b.ends_at : hi),
    candidates[0].ends_at
  );

  let snap: UsageSnapshot;
  try {
    snap = opts.snapshot ?? readSnapshot(rangeStart, rangeEnd, opts);
  } catch (e) {
    const err = asScreenTimeError(e);
    return { ...result, error: err.kind, detail: err.message };
  }

  const entries: OutcomeEntry[] = [];
  for (const block of candidates) {
    const report = reportForBlock(block, snap);
    const intent = INTENT_CATEGORY[block.block_type];
    const thin = report.coveragePct < MIN_COVERAGE_PCT;

    if (thin) {
      // Barely any usage. That only means "didn't happen" if we can show the Mac was
      // awake; a closed lid is an absence of evidence, not evidence of absence.
      const awake = report.awakeSeconds;
      const macWasAwake = awake === null ? report.totalSeconds > 0 : awake > 0;
      if (!macWasAwake) {
        result.skipped.push({ blockId: block.id, blockType: block.block_type, reason: "no_evidence" });
        continue;
      }
    }

    const completed = thin
      ? false
      : intent === "any"
        ? report.totalSeconds > 0
        : report.dominant === intent;

    const focusPct = report.categories.find((c) => c.category === "focus")?.pct ?? 0;
    const row: AutoCaptureRow = {
      blockId: block.id,
      blockType: block.block_type,
      completed,
      perceivedFocus: focusProxy(focusPct),
      note: evidenceNote(report),
      coveragePct: report.coveragePct,
      dominant: report.dominant,
    };
    result.rows.push(row);
    entries.push({
      blockId: row.blockId,
      completed: row.completed,
      actualStartAt: null,
      actualEndAt: null,
      perceivedFocus: row.perceivedFocus,
      note: row.note,
    });
  }

  if (entries.length > 0) result.captured = captureOutcomes(db, entries);
  return result;
}

// ── diagnostics ─────────────────────────────────────────────────────────────────
export interface ScreenTimeDiagnostics {
  ok: boolean;
  error?: ScreenTimeErrorKind;
  detail?: string;
  dbPath: string;
  /** Every ZSTREAMNAME present with a row count, biggest first. */
  streams: { stream: string; rows: number }[];
  hasAppUsage: boolean;
  hasInFocus: boolean;
  hasBacklit: boolean;
  /** Distinct ZSOURCE.ZDEVICEID values — more than one means iPhone/iPad rows sync in here. */
  devices: { deviceId: string | null; rows: number }[];
  earliestUsage: string | null;
  latestUsage: string | null;
}

/**
 * Read-only introspection of the live store — what streams exist on THIS Mac, and
 * whether other Apple devices sync usage into it. Run this once from the app (which
 * holds Full Disk Access) rather than trusting documentation.
 */
export function screenTimeDiagnostics(dbPath: string = DEFAULT_KNOWLEDGE_DB): ScreenTimeDiagnostics {
  const base: ScreenTimeDiagnostics = {
    ok: false, dbPath, streams: [], hasAppUsage: false, hasInFocus: false, hasBacklit: false,
    devices: [], earliestUsage: null, latestUsage: null,
  };
  let opened: OpenedCopy;
  try {
    opened = openKnowledgeCopy(dbPath);
  } catch (e) {
    const err = asScreenTimeError(e);
    return { ...base, error: err.kind, detail: err.message };
  }
  try {
    const streams = opened.db
      .prepare("SELECT ZSTREAMNAME AS stream, COUNT(*) AS rows FROM ZOBJECT GROUP BY ZSTREAMNAME ORDER BY rows DESC")
      .all() as { stream: string | null; rows: number }[];

    let devices: { deviceId: string | null; rows: number }[] = [];
    if (tableExists(opened.db, "ZSOURCE") && columns(opened.db, "ZSOURCE").has("ZDEVICEID")) {
      devices = opened.db
        .prepare(
          `SELECT src.ZDEVICEID AS deviceId, COUNT(*) AS rows
             FROM ZOBJECT o LEFT JOIN ZSOURCE src ON src.Z_PK = o.ZSOURCE
            WHERE o.ZSTREAMNAME = ? GROUP BY src.ZDEVICEID ORDER BY rows DESC`
        )
        .all(APP_USAGE_STREAM) as { deviceId: string | null; rows: number }[];
    }

    const bounds = opened.db
      .prepare("SELECT MIN(ZSTARTDATE) AS lo, MAX(ZENDDATE) AS hi FROM ZOBJECT WHERE ZSTREAMNAME = ?")
      .get(APP_USAGE_STREAM) as { lo: number | null; hi: number | null } | undefined;

    const names = new Set(streams.map((s) => s.stream ?? ""));
    return {
      ...base,
      ok: true,
      streams: streams.map((s) => ({ stream: s.stream ?? "(null)", rows: s.rows })),
      hasAppUsage: names.has(APP_USAGE_STREAM),
      hasInFocus: names.has(IN_FOCUS_STREAM),
      hasBacklit: names.has(BACKLIT_STREAM),
      devices,
      earliestUsage: bounds?.lo != null ? appleSecondsToDate(bounds.lo).toISOString() : null,
      latestUsage: bounds?.hi != null ? appleSecondsToDate(bounds.hi).toISOString() : null,
    };
  } catch (e) {
    const err = asScreenTimeError(e);
    return { ...base, error: err.kind, detail: err.message };
  } finally {
    opened.dispose();
  }
}
