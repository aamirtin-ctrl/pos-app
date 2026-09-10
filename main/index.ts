// Electron main: window lifecycle, macOS menu, DB, workers, IPC registration.

import { app, BrowserWindow, Menu, globalShortcut, screen, session, shell } from "electron";
import path from "node:path";
import { openDb, getSetting, type Db } from "./db/db.ts";
import { SecretStore } from "./secrets.ts";
import { LlmClient } from "./llm/provider.ts";
import {
  registerIpc,
  validateAccelerator,
  DEFAULT_GLOBAL_HOTKEY,
  GLOBAL_HOTKEY_KEY,
  type HotkeyState,
  type HudResult,
} from "./ipc.ts";
import { startWorkers, cleanupTentativeTasksV2, cleanupTentativeTasksV3 } from "./workers.ts";
import { reconcileGoogleTasks } from "./gtasks-sync.ts";
import { setAnchorsRefreshedNotifier } from "./gcal/sync.ts";
import { purgeBulkContactsOnce } from "./crm/review.ts";
import { loadDoctrine } from "./engine/doctrine.ts";
import { closePanel } from "./webpanel.ts";

let db: Db | null = null;
let win: BrowserWindow | null = null;
let hud: BrowserWindow | null = null;

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
    // The HUD is a hidden-but-open BrowserWindow, so on Windows/Linux it would keep
    // `window-all-closed` from ever firing and the app from ever quitting. macOS keeps
    // the process alive by convention anyway, so only the others need this.
    if (process.platform !== "darwin" && hud && !hud.isDestroyed()) hud.destroy();
  });
}

// ── system-wide voice capture hotkey + floating HUD ──────────────────────────
//
// "There needs to be a shortcut that opens the mic ... even when the app isn't the main
// thing on my screen." That is a globalShortcut, which fires no matter which app is
// frontmost — and is exactly why the accelerator cannot be the bare in-app `Shift+A`:
// registered globally it would swallow every capital A the owner types anywhere on the
// Mac. The default is a real chord; validateAccelerator (main/ipc.ts) refuses anything
// whose only modifier is Shift, whatever the user types into Settings.
//
// The second half of "even when the app isn't the main thing on my screen" is that POS
// must NOT become the main thing on his screen. An earlier pass answered the hotkey by
// show()/focus()/app.focus({steal:true}) on the main window, which yanks him out of
// whatever he was mid-sentence in — the exact cost the shortcut exists to avoid. So the
// hotkey opens a small always-on-top HUD with showInactive(): the window appears and
// starts recording while keyboard focus stays with the app he is actually using.
// getUserMedia has no focus requirement, so the mic works from an unfocused window.

const HUD_WIDTH = 300;
const HUD_HEIGHT = 84;
const HUD_TOP_MARGIN = 28;

let hotkeyState: HotkeyState = { accelerator: DEFAULT_GLOBAL_HOTKEY, registered: false };
let boundAccelerator: string | null = null; // what globalShortcut currently holds
/** True from the first-ever press until the HUD has painted — see onHotkey(). */
let hudBooting = false;

/**
 * Create the HUD once and keep it. Hidden between uses rather than destroyed: recreating
 * it would re-run the renderer load and the getUserMedia handshake (~2s on macOS even
 * once granted) on every press, which is most of the latency the hotkey is there to save.
 */
function ensureHud(): BrowserWindow {
  if (hud && !hud.isDestroyed()) return hud;
  const w = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false, // never show() — see showHud()
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // This window is never focused and spends most of its life hidden — exactly the
      // two conditions Chromium throttles timers under. The elapsed-seconds counter and
      // the audio worklet feeding whisper both depend on those timers firing on time.
      backgroundThrottling: false,
    },
  });
  // "screen-saver" is the level above floating/torn-off panels — without it the HUD
  // sits under a full-screen app's own chrome, which is precisely where he'd be when
  // he reaches for the shortcut.
  w.setAlwaysOnTop(true, "screen-saver");
  if (process.platform === "darwin") {
    // Follow him across Spaces and onto a full-screen app instead of yanking the Space
    // back to wherever POS happens to live.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (process.env.VITE_DEV) {
    w.loadURL("http://localhost:5183/#/overlay");
  } else {
    w.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"), { hash: "/overlay" });
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  w.on("closed", () => {
    if (hud === w) hud = null;
    // Otherwise a window destroyed mid-boot leaves the flag stuck and every later press
    // is silently swallowed.
    hudBooting = false;
  });
  hud = w;
  return w;
}

/** Top-centre of whichever display the pointer is on — where he is already looking. */
function positionHud(w: BrowserWindow) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  w.setBounds({
    x: Math.round(area.x + (area.width - HUD_WIDTH) / 2),
    y: Math.round(area.y + HUD_TOP_MARGIN),
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
  });
}

/**
 * showInactive() and nothing else. show(), focus() and app.focus() all activate POS and
 * move keyboard focus off the app he is working in — the one thing this feature must
 * never do. Anything added here should be checked against that.
 */
function showHud(w: BrowserWindow) {
  positionHud(w);
  w.setAlwaysOnTop(true, "screen-saver");
  w.showInactive();
}

/** The renderer isn't listening until React has mounted; queue behind the first load. */
function sendVoiceCapture(target: BrowserWindow) {
  const wc = target.webContents;
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => {
      setTimeout(() => {
        if (!target.isDestroyed()) target.webContents.send("pos:voice-capture");
      }, 250);
    });
  } else {
    wc.send("pos:voice-capture");
  }
}

/**
 * Toggle. Hidden → show and start recording. Visible → tell the HUD to stop and
 * transcribe (or, if it had already finished, start a fresh capture); the HUD owns that
 * distinction because it owns the recorder.
 *
 * The first press of all is the exception: the window is being created, and VoiceHud
 * starts recording on mount, so sending a toggle as well would immediately stop it.
 */
function onHotkey() {
  const fresh = !hud || hud.isDestroyed();
  const w = ensureHud();
  if (fresh) {
    // Show on first paint, not immediately: a transparent window shown before its first
    // frame is a hole punched over his screen for a few hundred ms. The timer is the
    // belt — ready-to-show is the one Electron event worth not betting the feature on.
    hudBooting = true;
    positionHud(w);
    const reveal = () => {
      if (!hudBooting || w.isDestroyed()) return;
      hudBooting = false;
      showHud(w);
    };
    w.once("ready-to-show", reveal);
    setTimeout(reveal, 1500);
    return;
  }
  // Cold start still in flight: the mount is already about to start recording, and a
  // toggle arriving right behind it would stop a capture half a second old.
  if (hudBooting) return;
  if (w.isVisible()) {
    w.webContents.send("pos:voice-capture");
    return;
  }
  showHud(w);
  sendVoiceCapture(w);
}

/** `hud.result` — the capture is over (finished, cancelled or failed). Put it away. */
function onHudResult(_payload: HudResult) {
  if (hud && !hud.isDestroyed() && hud.isVisible()) hud.hide();
}

/**
 * Validate → unregister the old → register the new. Never leaves the owner with nothing:
 * if the new accelerator is refused (another app already owns it), the previous one is
 * put back and the failure is returned for the Settings row to show.
 */
function applyGlobalHotkey(accelerator: string): HotkeyState {
  const v = validateAccelerator(accelerator);
  if (!v.ok) return { accelerator: (accelerator ?? "").trim(), registered: false, error: v.error };
  const acc = v.accelerator;
  if (acc === boundAccelerator) return { accelerator: acc, registered: true };

  const previous = boundAccelerator;
  if (previous) {
    globalShortcut.unregister(previous);
    boundAccelerator = null;
  }
  let taken = false;
  try {
    taken = globalShortcut.register(acc, onHotkey);
  } catch (e) {
    taken = false;
  }
  if (taken) {
    boundAccelerator = acc;
    return { accelerator: acc, registered: true };
  }
  // Put the working one back rather than leaving the owner with no shortcut at all.
  if (previous && globalShortcut.register(previous, onHotkey)) boundAccelerator = previous;
  return {
    accelerator: acc,
    registered: false,
    error: `${acc} is already taken by another app — pick a different chord.${
      boundAccelerator ? ` Still using ${boundAccelerator}.` : ""
    }`,
  };
}

// Startup: honour the saved accelerator, fall back to the default if it no longer works
// (an app installed since could have claimed it) — and keep the reason visible in Settings.
function initGlobalHotkey(database: Db) {
  const saved = (getSetting(database, GLOBAL_HOTKEY_KEY) ?? "").trim();
  const wanted = saved || DEFAULT_GLOBAL_HOTKEY;
  let state = applyGlobalHotkey(wanted);
  if (!state.registered && wanted !== DEFAULT_GLOBAL_HOTKEY) {
    const fallback = applyGlobalHotkey(DEFAULT_GLOBAL_HOTKEY);
    state = fallback.registered
      ? { ...fallback, error: `${state.error} Fell back to ${fallback.accelerator}.` }
      : state;
  }
  hotkeyState = state;
  if (!state.registered) console.warn(`global hotkey unavailable: ${state.error}`);
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

  registerIpc({
    db,
    secrets,
    doctrineDir: userData,
    llm,
    hotkey: {
      get: () => hotkeyState,
      set: (accelerator: string) => (hotkeyState = applyGlobalHotkey(accelerator)),
    },
    hud: { result: onHudResult },
  });
  startWorkers(db, secrets, llm(), (msg: string) => {
    win?.webContents.send("pos:notify", msg);
  });
  // When a background anchors refresh finds the served snapshot was stale (event added or
  // deleted from Apple/Google on another device), ping the day view so it re-pulls that date.
  setAnchorsRefreshedNotifier((dateISO: string) => {
    if (win && !win.isDestroyed()) win.webContents.send("pos:day-changed", dateISO);
  });
  // Owner report 2026-08-06: "I just marked as completed several google tasks. This didn't
  // reflect on the app." The 15-minute tick is the durability net; this is the latency fix —
  // a lightweight, health-gated pull the instant he looks at the app, so a completion checked
  // off on his phone minutes ago is not still waiting on the clock.
  win?.on("focus", () => {
    void reconcileGoogleTasks(db!, secrets).catch(() => { /* the 15-min tick still covers it */ });
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
  initGlobalHotkey(db);
  app.on("activate", () => {
    // Keyed on the main window, not the window count: the voice HUD is a second (hidden)
    // BrowserWindow, so a count check would silently stop re-opening the app from the dock.
    if (!win || win.isDestroyed()) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention: app stays alive; sync workers keep running while open.
  // The HUD is a window too, but a hidden one — it never keeps the app alive on its
  // own and it must not stop a real quit on Windows/Linux either.
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  // A globalShortcut outlives the app's windows — drop it before the process goes.
  globalShortcut.unregisterAll();
  boundAccelerator = null;
  // The HUD is kept (hidden) between uses; this is the one place it gets torn down.
  if (hud && !hud.isDestroyed()) hud.destroy();
  hud = null;
  db?.close();
});
