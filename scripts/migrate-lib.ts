// Pure mapping helpers for the Postgres→SQLite migration (scripts/migrate-from-postgres.ts).
// No I/O here — everything is unit-testable (tests/migrate-map.test.ts).

/** "Send deck (due 2026-09-01)" → { description: "Send deck", due_at: "2026-09-01T00:00:00" }. */
export function parseFollowUp(followUp: string): { description: string; due_at: string | null } {
  const m = followUp.match(/\s*\(due\s+(\d{4}-\d{2}-\d{2})\)\s*$/i);
  if (!m) return { description: followUp.trim(), due_at: null };
  return {
    description: followUp.slice(0, m.index).trim(),
    due_at: `${m[1]}T00:00:00`,
  };
}

/** Best-effort given/family split. Only splits when the name has ≥2 tokens. */
export function splitName(name: string): { given: string | null; family: string | null } {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { given: null, family: null };
  return { given: tokens[0], family: tokens[tokens.length - 1] };
}

/** Comma-string → trimmed, deduped list. Optionally lowercased (tags). */
export function commaSplit(s: string | null | undefined, opts: { lowercase?: boolean } = {}): string[] {
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(",")) {
    let v = raw.trim();
    if (!v) continue;
    if (opts.lowercase) v = v.toLowerCase();
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** staging.direction → interaction.direction: 'connection'→'mutual', else carry (incl. null). */
export function mapDirection(direction: string | null | undefined): string | null {
  if (direction == null) return null;
  return direction === "connection" ? "mutual" : direction;
}

/** "YYYY-MM-DD" (Postgres DATE) → ISO datetime at midnight. Null-safe. */
export function dateToMidnightIso(d: string | null | undefined): string | null {
  if (!d) return null;
  return `${d}T00:00:00`;
}

/** JS Date (pg timestamp) → ISO string. Null-safe. */
export function tsToIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** person.bio = notes (+ "Personal: <detail>" appended on a new line when present). */
export function buildBio(notes: string | null, personalDetail: string | null): string | null {
  const detail = personalDetail?.trim();
  if (!detail) return notes;
  const line = `Personal: ${detail}`;
  return notes ? `${notes}\n${line}` : line;
}

/** Mine thread_external_id / threadId out of raw_meta JSON (object or JSON string). */
export function threadFromRawMeta(rawMeta: unknown): string | null {
  let meta: unknown = rawMeta;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return null;
    }
  }
  if (meta == null || typeof meta !== "object") return null;
  const o = meta as Record<string, unknown>;
  const v = o.thread_external_id ?? o.threadId;
  return v == null ? null : String(v);
}
