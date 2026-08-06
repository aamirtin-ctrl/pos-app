// Electron main: window lifecycle, macOS menu, DB, workers, IPC registration.

import { app, BrowserWindow, Menu, session, shell } from "electron";
import path from "node:path";
import { openDb, type Db } from "./db/db.ts";
import { SecretStore } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import { registerIpc } from "./ipc.ts";
import { startWorkers, cleanupTentativeTasksV2, cleanupTentativeTasksV3 } from "./workers.ts";
import { purgeBulkContactsOnce } from "./crm/review.ts";
import { loadDoctrine } from "./engine/doctrine.ts";
import { closePanel } from "./webpanel.ts";

let db: Db | null = null;
let win: BrowserWindow | null = null;

// Our own UI: the Vite dev server in dev, a file:// bundle in the packaged app.
// (A file:// page reports its origin as "file://" or the opaque "null".)
function isOwnOrigin(url: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("file://") ||
    url === "null" ||
    (!!process.env.VITE_DEV && url.startsWith("http://localhost:5183"))
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#faf9f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV) {
    win.loadURL("http://localhost:5183");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // A docked web panel is a child view of this window — drop it with the window so
  // its webContents (and the third-party session behind it) never outlives the UI
  // that was framing it. webpanel.ts also self-cleans, but the module-level handle
  // to a dead window is exactly the kind of thing worth closing twice.
  const self = win;
  self.on("closed", () => {
    closePanel(self);
    if (win === self) win = null;
  });
}

// Spec-locked data location: ~/Library/Application Support/pos — pin it BEFORE ready
// so Electron never invents a productName-cased sibling ("POS/").
app.setPath("userData", path.join(app.getPath("appData"), "pos"));

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  app.setName("POS");
  db = openDb(path.join(userData, "pos.db"));
  const secrets = new SecretStore(userData);
  loadDoctrine(userData); // seed doctrine.yaml on first run
  const llm = () => {
    const c = new LlmClient(db!, secrets);
    return c.provider() ? c : null;
  };

  registerIpc({ db, secrets, doctrineDir: userData, llm });
  startWorkers(db, secrets, llm(), (msg: string) => {
    win?.webContents.send("pos:notify", msg);
  });

  // One-time full reset (keyed on setting cleanup_tentative_v2, superseding the v1
  // junk-only repair): delete ALL auto-created commitment-linked tasks from the
  // 2026-08-04+ incident window — even the v1 "legitimate" survivors, whose
  // descriptions and dates came from the context-blind, today-defaulting pipeline —
  // close their Google counterparts best-effort, and return the underlying
  // commitments to the review queue for the fixed pipeline. Async and non-blocking;
  // never fails startup.
  void cleanupTentativeTasksV2(db, secrets)
    .catch((e: Error) =>
      console.warn(`cleanup_tentative_v2 failed (will retry next launch): ${e.message}`)
    )
    .then(() => {
      // One-time expired same-day sweep (keyed on cleanup_tentative_v3): drop review-
      // queue commitments whose only temporal reference ("at 5:30", "tonight") was
      // scoped to a sent day that has since passed. Runs AFTER v2 so commitments v2
      // just returned to review are swept in the same launch.
      try {
        cleanupTentativeTasksV3(db!);
      } catch (e) {
        console.warn(`cleanup_tentative_v3 failed (will retry next launch): ${(e as Error).message}`);
      }
    });

  // One-shot: remove the newsletter/notification contacts the pre-header-filter
  // ingest created. Conservative — only unverified people whose every interaction
  // is inbound bulk mail. Never throws; the setting flag makes reruns a no-op.
  try {
    const { ran, purged } = purgeBulkContactsOnce(db);
    if (ran) console.log(`cleanup_bulk_v1 purged ${purged} bulk contact(s)`);
  } catch (e) {
    console.warn(`cleanup_bulk_v1 failed: ${(e as Error).message}`);
  }

  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" as const },
      { role: "viewMenu" as const },
      { role: "windowMenu" as const },
    ])
  );

  // Microphone for the command-bar dictation. Electron's default handler is permissive,
  // but that default is exactly the kind of thing that changes between versions and
  // configurations — and when it denies, getUserMedia rejects with a bare NotAllowedError
  // that looks identical to the user denying at the OS prompt. Be explicit: grant `media`
  // to our own page only, deny everything else. macOS TCC still gates real device access.
  // Our own page keeps the permissive default it already had (clipboard writes in the
  // inbox and contact views depend on it); anything else is denied outright.
  session.defaultSession.setPermissionRequestHandler((wc, _permission, callback, details) => {
    callback(isOwnOrigin(details?.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, _permission, requestingOrigin) =>
    isOwnOrigin(requestingOrigin || wc?.getURL() || "")
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention: app stays alive; sync workers keep running while open
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  db?.close();
});
