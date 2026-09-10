// One-shot maintenance runner: purge orphaned Google Tasks rows without the UI.
//
// Exists because the app itself would not open (startup reconcile grinding through
// ~6400 orphaned rows), and the purge normally lives behind the Settings button.
// Runs under Electron — NOT node — because secrets.json is safeStorage-encrypted
// and only decrypts inside Electron with the same app identity. So this replicates
// index.ts's exact boot lines (setPath userData → openDb → SecretStore) minus the
// window, prints what it did as JSON, and exits.
//
//   npx electron dist-main/headless-purge.cjs preview   # count only, deletes nothing
//   npx electron dist-main/headless-purge.cjs apply     # delete orphans
import path from "node:path";
import { app } from "electron";
import { openDb } from "../main/db/db.ts";
import { SecretStore } from "../main/secrets.ts";
import { purgeOrphanedGoogleTasks } from "../main/gtasks-sync.ts";

const MODE = process.argv[2] === "apply" ? "apply" : "preview";

// Identity BEFORE ready: safeStorage's Keychain entry is derived from the app
// name, and a late setName leaves this process decrypting with "Electron"'s
// key — every secret silently reads as null and Google looks disconnected.
app.setName("POS");
// No Dock icon: this ran 11 hours as a bare "Electron" in the Dock and the owner,
// quite reasonably, quit it thinking it was the app. Invisible is honest here.
app.dock?.hide();
app.setPath("userData", path.join(app.getPath("appData"), "pos"));

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const db = openDb(path.join(userData, "pos.db"));
  const secrets = new SecretStore(userData);
  // Sanity line, booleans only — never the values.
  console.log(JSON.stringify({
    canDecrypt: secrets.get("GOOGLE_OAUTH_TOKENS") != null,
  }));

  const res = await purgeOrphanedGoogleTasks(db, secrets, { apply: MODE === "apply" });
  console.log(JSON.stringify({ mode: MODE, ...res }, null, 1));
  app.exit(res.error ? 1 : 0);
});
