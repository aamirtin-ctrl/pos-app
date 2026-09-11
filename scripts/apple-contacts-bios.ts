// CLI wrapper for main/crm/apple-bios.ts — mirror POS bios into Apple Contacts, creating
// cards for people the Mac doesn't know. The daily worker tick runs the same sync; this is
// the on-demand/dry-run entry.
//
//   npm run contacts:bios            dry run — report what would change
//   npm run contacts:bios -- apply   write notes + create missing contacts
import { join } from "node:path";
import os from "node:os";
import { openDb } from "../main/db/db.ts";
import { syncAppleContactBios } from "../main/crm/apple-bios.ts";

const APPLY = process.argv.includes("apply");

(async () => {
  const db = openDb(join(os.homedir(), "Library/Application Support/POS/pos.db"));
  const r = await syncAppleContactBios(db, { apply: APPLY });
  console.log(
    `${APPLY ? "" : "(dry run) "}matched=${r.matched} notes-updated=${r.updated} contacts-created=${r.created} skipped-bare-numbers=${r.skippedUncreatable} verified-by-edit=${r.verifiedByEdit} deleted-mirrored=${r.deletedMirrored}`
  );
  if (r.ambiguous.length) console.log(`ambiguous names (several Apple cards, untouched): ${r.ambiguous.join(", ")}`);
})().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
