// Electron main: window lifecycle, macOS menu, DB, workers, IPC registration.

import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import { openDb, type Db } from "./db/db.ts";
import { SecretStore } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import { registerIpc } from "./ipc.ts";
import { startWorkers } from "./workers.ts";
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

app.whenReady().then(() => {
  const userData = app.getPath("userData"); // ~/Library/Application Support/pos
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
