// macOS Contacts (AddressBook) name lookup — Mac-only, LOCAL, READ-ONLY.
// Ported from PersonalCRM2 lib/addressbook.ts. Maps a normalized phone/email → the saved
// contact's name so iMessage 1-1 counterparts can become named people. Best-effort: any
// failure (no DB, no Full Disk Access, schema drift) returns an empty index and the caller
// creates nothing. Same safety posture as the iMessage connector — copy each DB to a temp
// path and open it read-only.

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEmail, normalizePhone } from "../crm/normalize.ts";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const req: ReturnType<typeof createRequire> =
  typeof require === "function" ? require : createRequire(import.meta.url);

export interface NameHit {
  name: string;
  company: string | null;
}

/** Compose a display name from AddressBook fields: "First Last", else org, else null. */
export function personName(first: unknown, last: unknown, org: unknown): string | null {
  const f = typeof first === "string" ? first.trim() : "";
  const l = typeof last === "string" ? last.trim() : "";
  const full = `${f} ${l}`.trim();
  if (full) return full;
  const o = typeof org === "string" ? org.trim() : "";
  return o || null;
}

/** All AddressBook source DBs on this Mac (top-level + per-source). */
function dbPaths(): string[] {
  const base = join(homedir(), "Library", "Application Support", "AddressBook");
  const out: string[] = [];
  const top = join(base, "AddressBook-v22.abcddb");
  if (existsSync(top)) out.push(top);
  const sources = join(base, "Sources");
  if (existsSync(sources)) {
    try {
      for (const d of readdirSync(sources)) {
        const p = join(sources, d, "AddressBook-v22.abcddb");
        if (existsSync(p)) out.push(p);
      }
    } catch {
      /* ignore unreadable Sources dir */
    }
  }
  return out;
}

export interface NameIndex {
  index: Map<string, NameHit>; // keyed by normalized phone AND normalized email
  people: number;
  sources: number;
}

/** Build a phone/email → name index from all AddressBook DBs. Never throws. */
export function buildNameIndex(paths: string[] = dbPaths()): NameIndex {
  const index = new Map<string, NameHit>();
  let sources = 0;

  // better-sqlite3's export IS the Database class — hold it directly and `new` it below.
  // (The previous arrow-function wrapper here was NOT a constructor: every `new
  // DatabaseSync(...)` threw, the per-source catch ate it, and this returned an empty
  // index for months — which is how every saved contact still texted as a bare number.)
  let Db3: new (path: string, opts: { readonly: boolean; fileMustExist: boolean }) => SqliteDatabase;
  try {
    Db3 = req("better-sqlite3");
  } catch {
    return { index, people: 0, sources: 0 };
  }

  const add = (key: string | undefined, hit: NameHit) => {
    if (key && !index.has(key)) index.set(key, hit);
  };

  for (const src of paths) {
    const workDir = mkdtempSync(join(tmpdir(), "pos-ab-"));
    const work = join(workDir, "ab.abcddb");
    try {
      copyFileSync(src, work);
      for (const ext of ["-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, work + ext);
      const db = new Db3(work, { readonly: true, fileMustExist: true });
      db.exec("PRAGMA query_only = ON;");
      sources++;

      const phones = db
        .prepare(
          `SELECT r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION org, p.ZFULLNUMBER num
           FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of phones) {
        const name = personName(row.f, row.l, row.org);
        if (!name) continue;
        const norm = normalizePhone(typeof row.num === "string" ? row.num : null)?.norm;
        const company = typeof row.org === "string" && row.org.trim() ? row.org.trim() : null;
        add(norm, { name, company });
      }

      const emails = db
        .prepare(
          `SELECT r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION org, e.ZADDRESS addr
           FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of emails) {
        const name = personName(row.f, row.l, row.org);
        if (!name) continue;
        const norm = normalizeEmail(typeof row.addr === "string" ? row.addr : null)?.norm;
        const company = typeof row.org === "string" && row.org.trim() ? row.org.trim() : null;
        add(norm, { name, company });
      }

      db.close();
    } catch (e) {
      // Best-effort per SOURCE, but never silent: a swallowed error here is exactly how
      // the arrow-constructor bug hid for months. One line per failed source.
      console.warn(`addressbook: skipped ${src}: ${(e as Error).message}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (paths.length > 0 && sources === 0) {
    console.warn(
      `addressbook: ALL ${paths.length} Contacts DB(s) unreadable — saved names unavailable this run`
    );
  }
  return { index, people: index.size, sources };
}
