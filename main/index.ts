// Electron main: window lifecycle, macOS menu, DB, workers, IPC registration.

import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import { openDb, type Db } from "./db/db.ts";
import { SecretStore } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import { registerIpc } from "./ipc.ts";
import { startWorkers, cleanupTentativeTasksV2 } from "./workers.ts";
import { loadDoctrine } from "./engine/doctrine.ts";

let db: Db | null = null;
let win: BrowserWindow | null = null;

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
  void cleanupTentativeTasksV2(db, secrets).catch((e: Error) =>
    console.warn(`cleanup_tentative_v2 failed (will retry next launch): ${e.message}`)
  );

  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      { role: "editMenu" as const },
      { role: "viewMenu" as const },
      { role: "windowMenu" as const },
    ])
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
