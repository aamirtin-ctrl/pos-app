// Subscribed calendars (webcal / ICS feeds) — read-only anchors.
//
// A published iCloud calendar, a class schedule, a team calendar: anything that
// speaks RFC 5545 over a URL becomes anchors for the planner and events on the
// day view, exactly like Google and Apple events do. READ ONLY — POS never
// writes to a subscribed feed (there is nothing to write to; they are one-way
// by design).
//
// Identity: every VEVENT carries an RFC 5545 UID, the same join key
// mergeCalendarSources already uses. An event that reaches POS both through a
// feed and through Google/Apple blocks the day exactly once.
//
// Subscriptions live in the `ics_subscriptions` setting as a JSON array of
// { id, url, name }. Feeds are fetched with a 10s time-box and the parsed
// result is cached in-process for 15 minutes, so flipping between days does
// not refetch, and one dead feed never breaks the others (skip + warn).

import ical, { type CalendarResponse, type VEvent, type ParameterValue } from "node-ical";
import { randomUUID } from "node:crypto";
import type { Db } from "./db/db.ts";
import { getSetting, setSetting } from "./db/db.ts";
import { appleBlockType } from "./applecal.ts";
import { persistDayCache, readDayCache } from "./gcal/sync.ts";

/** settings key holding the JSON subscription list. */
export const ICS_SUBSCRIPTIONS_KEY = "ics_subscriptions";

/**
 * The owner's first feed, seeded on the very first read so the published
 * iCloud calendar works out of the box with zero setup.
 */
export const SEED_SUBSCRIPTION_URL =
  "webcal://p135-caldav.icloud.com/published/2/MTM1ODA5NDk4NTEzNTgwOR_8KyhdpBs8jKgU-D6Dq16Ro_7RQfvEzic2fjM53xPPTAatEXKYG2iJtwy4BNHV_bk0w88wJe7rsfato4EBxUY";
export const SEED_SUBSCRIPTION_NAME = "iCloud published";

export interface IcsSubscription {
  id: string;
  url: string;
  name: string;
}

export interface IcsEvent {
  /** RFC 5545 UID — the cross-system join key for the merge/dedupe. */
  uid: string;
  title: string;
  /** minutes since midnight of the queried day, LOCAL time */
  startMin: number;
  /** minutes since midnight, clamped to 1440 for events running past midnight */
  endMin: number;
  /** always false here — date-only events are skipped (all-day never blocks) */
  allDay: boolean;
}

// ── pure helpers (unit-tested; no network, no DB) ────────────────────────────

/**
 * webcal:// (and webcals://) are just https:// with a "subscribe to me" hat on.
 * Normalizes to a fetchable URL; throws on anything that is not http(s).
 */
export function normalizeIcsUrl(raw: string): string {
  const replaced = (raw ?? "").trim().replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(replaced);
  } catch {
    throw new Error(`not a valid calendar URL: ${(raw ?? "").trim() || "(empty)"}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`unsupported protocol: ${u.protocol.replace(/:$/, "")}`);
  }
  return u.toString();
}

/** SUMMARY can be a plain string or { val, params } — collapse to text. */
const summaryText = (s: ParameterValue | undefined): string => {
  const v = typeof s === "string" ? s : (s?.val ?? "");
  return v.trim() || "(busy)";
};

/** Anchor-type heuristic — same guess as Apple events (empty calendar name). */
export function icsBlockType(title: string): "meeting" | "personal" {
  return appleBlockType(title, "");
}

/**
 * Expand one parsed feed into the timed events of a single LOCAL day.
 *
 * Recurrences go through node-ical's expandRecurringEvent, which handles
 * RRULE/EXDATE/RECURRENCE-ID; the window is exactly the target day, so a
 * weekly rule yields at most the occurrences whose start falls on that day.
 * Hours/minutes are derived from the returned Date objects in local time —
 * node-ical has already resolved feed timezones to real instants.
 * Date-only (all-day) events are skipped: like the Google and Apple paths,
 * all-day never blocks planning time.
 */
export function eventsFromParsed(parsed: CalendarResponse, dateISO: string): IcsEvent[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error(`bad date: ${dateISO}`);
  const dayStart = new Date(`${dateISO}T00:00:00`);
  // inclusive window end just before next midnight, so a 00:00-tomorrow start is out
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);

  const out: IcsEvent[] = [];
  for (const comp of Object.values(parsed ?? {})) {
    if (!comp || (comp as { type?: string }).type !== "VEVENT") continue;
    const ev = comp as VEvent;
    if (ev.status === "CANCELLED") continue;
    if (ev.datetype === "date" || ev.start?.dateOnly) continue; // all-day never blocks
    if (!(ev.start instanceof Date)) continue;

    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try {
      instances = ical.expandRecurringEvent(ev, { from: dayStart, to: dayEnd });
    } catch {
      continue; // one malformed rule must not take the feed down
    }
    for (const inst of instances) {
      if (inst.isFullDay) continue;
      if (inst.event.status === "CANCELLED") continue; // cancelled single occurrence
      const startMin = inst.start.getHours() * 60 + inst.start.getMinutes();
      const durationMin = Math.round((inst.end.getTime() - inst.start.getTime()) / 60_000);
      // clamp: an event running past midnight only occupies the rest of this day
      const endMin = Math.min(1440, durationMin > 0 ? startMin + durationMin : startMin + 15);
      out.push({
        uid: (inst.event.uid ?? ev.uid ?? "").trim(),
        title: summaryText(inst.summary),
        startMin,
        endMin,
        allDay: false,
      });
    }
  }
  return out.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
}

// ── subscription list (settings-backed) ──────────────────────────────────────

const isSubscription = (v: unknown): v is IcsSubscription =>
  !!v && typeof v === "object" &&
  typeof (v as IcsSubscription).id === "string" &&
  typeof (v as IcsSubscription).url === "string" &&
  typeof (v as IcsSubscription).name === "string";

function saveSubscriptions(db: Db, subs: IcsSubscription[]): void {
  setSetting(db, ICS_SUBSCRIPTIONS_KEY, JSON.stringify(subs));
}

/**
 * The subscription list. On the very first read (setting absent) the owner's
 * published iCloud feed is seeded — stored already normalized to https so
 * every later fetch is direct. A present-but-unparseable value reads as empty
 * without being overwritten (never destroy what we cannot read).
 */
export function listSubscriptions(db: Db): IcsSubscription[] {
  const raw = getSetting(db, ICS_SUBSCRIPTIONS_KEY);
  if (raw == null) {
    const seeded: IcsSubscription[] = [
      { id: randomUUID(), url: normalizeIcsUrl(SEED_SUBSCRIPTION_URL), name: SEED_SUBSCRIPTION_NAME },
    ];
    saveSubscriptions(db, seeded);
    return seeded;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSubscription) : [];
  } catch {
    return [];
  }
}

/**
 * Add a feed. The URL is normalized (webcal → https) and validated by actually
 * fetching and parsing it — a typo'd URL fails here, not silently on the next
 * planner run. The validated parse also primes the feed cache, and can supply
 * a name (X-WR-CALNAME) when the user gave none. Tests inject `opts.validate`
 * to stay off the network.
 */
export async function addSubscription(
  db: Db,
  url: string,
  name?: string,
  opts?: { validate?: (normalizedUrl: string) => Promise<string | undefined> }
): Promise<IcsSubscription> {
  const normalized = normalizeIcsUrl(url);
  const subs = listSubscriptions(db);
  const existing = subs.find((s) => s.url === normalized);
  if (existing) return existing; // adding the same feed twice is not an error

  const validate =
    opts?.validate ??
    (async (u: string) => {
      const parsed = await fetchFeed(u);
      const cal = parsed.vcalendar as { "WR-CALNAME"?: string } | undefined;
      return cal?.["WR-CALNAME"];
    });
  const feedName = await validate(normalized);

  const sub: IcsSubscription = {
    id: randomUUID(),
    url: normalized,
    name: (name ?? "").trim() || (feedName ?? "").trim() || new URL(normalized).hostname,
  };
  saveSubscriptions(db, [...subs, sub]);
  return sub;
}

export function removeSubscription(db: Db, id: string): { removed: boolean } {
  const subs = listSubscriptions(db);
  const next = subs.filter((s) => s.id !== id);
  if (next.length === subs.length) return { removed: false };
  saveSubscriptions(db, next);
  return { removed: true };
}

// ── fetch + cache ────────────────────────────────────────────────────────────

// Day-flipping asks for adjacent days within seconds; feeds change rarely.
// One warm parse serves every day the flip lands on for 15 minutes.
const FEED_TTL_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const feedCache = new Map<string, { at: number; parsed: CalendarResponse }>();

/** Testing/refresh hook — drops the in-process feed cache. */
export function clearIcsCache(): void {
  feedCache.clear();
}

async function fetchFeed(url: string): Promise<CalendarResponse> {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.parsed;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await ical.async.parseICS(await res.text());
    feedCache.set(url, { at: Date.now(), parsed });
    return parsed;
  } catch (err) {
    // AbortError's default message is unhelpful; say what actually happened
    if ((err as Error).name === "AbortError") {
      throw new Error(`feed did not answer within ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** settings key prefix for persisted per-date event snapshots (see gcal/sync.ts helpers). */
export const ICS_CACHE_PREFIX = "ics_cache:";

/** True when every subscribed feed is warm in the in-process cache (no network needed). */
function feedsWarm(db: Db): boolean {
  const now = Date.now();
  return listSubscriptions(db).every((s) => {
    const hit = feedCache.get(s.url);
    return !!hit && now - hit.at < FEED_TTL_MS;
  });
}

// Dates with a background feed refresh already in flight (persisted-data fast path).
const icsRefreshing = new Set<string>();

/**
 * Every timed event on `dateISO` across ALL subscribed feeds. Per-feed
 * failures are skipped with a warning — one dead feed never hides the others,
 * and never breaks planning.
 *
 * COLD feed cache + persisted snapshot present → the snapshot is returned
 * immediately and the feeds refresh fire-and-forget (updating the feed cache and
 * the snapshot), so an app relaunch never pays the ~1s parse on first open.
 */
export async function eventsForDate(db: Db, dateISO: string): Promise<IcsEvent[]> {
  if (feedsWarm(db)) return eventsForDateLive(db, dateISO);
  const persisted = readDayCache<unknown>(db, ICS_CACHE_PREFIX, dateISO);
  if (Array.isArray(persisted)) {
    if (!icsRefreshing.has(dateISO)) {
      icsRefreshing.add(dateISO);
      void eventsForDateLive(db, dateISO)
        .catch((err) => console.warn(`ics: background feed refresh failed: ${(err as Error).message}`))
        .finally(() => icsRefreshing.delete(dateISO));
    }
    return persisted as IcsEvent[];
  }
  return eventsForDateLive(db, dateISO);
}

/** The actual fetch+expand; persists the snapshot only when every feed answered. */
async function eventsForDateLive(db: Db, dateISO: string): Promise<IcsEvent[]> {
  const out: IcsEvent[] = [];
  let degraded = false;
  for (const sub of listSubscriptions(db)) {
    try {
      out.push(...eventsFromParsed(await fetchFeed(sub.url), dateISO));
    } catch (err) {
      degraded = true;
      console.warn(`ics feed "${sub.name}" unavailable: ${(err as Error).message}`);
    }
  }
  // A partial day (dead feed) must not overwrite a complete last-known snapshot.
  if (!degraded) {
    try {
      persistDayCache(db, ICS_CACHE_PREFIX, dateISO, JSON.stringify(out));
    } catch (err) {
      console.warn(`ics: persisting events snapshot failed: ${(err as Error).message}`);
    }
  }
  return out;
}
