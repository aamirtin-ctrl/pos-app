// Docked in-app web panels: Snapchat / Instagram DMs / LinkedIn messaging rendered
// as a native WebContentsView glued to the right-hand side of the main window.
//
// Why a view and not a window: these three services are only reachable on the web,
// and the owner wants them *in* the app next to the unified inbox — not as three
// stray windows he has to hunt for in Mission Control. The renderer owns layout
// (it reserves a column and reports the rect); this module just parks a native
// view over that rect.
//
// Electron has no type-level guarantee that `require("electron")` resolves outside
// the Electron runtime, so every electron touch is lazy (same trick as
// main/secrets.ts). That keeps this module importable from plain-node unit tests,
// which is what tests/webpanel.test.ts relies on — the URL policy below is the
// part worth testing and it must stay testable without booting a browser.

import type { BrowserWindow, WebContentsView, Rectangle, HandlerDetails } from "electron";

function el(): typeof import("electron") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("electron") as typeof import("electron");
}

// ── service registry ──────────────────────────────────────────────────────────

export interface PanelService {
  /** Stable id — the IPC argument and the renderer's button key. */
  id: string;
  label: string;
  /** Where the panel starts, and where a blocked navigation is sent back to. */
  url: string;
  /**
   * A distinct persistent partition per service: logins stick across restarts,
   * and no service can read another's cookies — or the app's default session.
   */
  partition: string;
  /**
   * When present, top-level navigation inside the service's own domain is confined
   * to these path prefixes. Absent = the whole domain is fair game.
   */
  allowPathPrefixes?: string[];
}

/**
 * Instagram's allowed paths. `/direct` is the actual product surface; everything
 * else here exists so the owner can *get* to it:
 *
 *   - `/accounts/login`   — verified: an unauthenticated GET of
 *                           https://www.instagram.com/direct/inbox/ answers 302 to
 *                           /accounts/login/?next=…%2Fdirect%2Finbox%2F. Two-factor
 *                           lives under /accounts/login/two_factor, so the prefix
 *                           covers it.
 *   - `/accounts/onetap`  — verified as a real route (302s to login when signed out):
 *                           the "Save your login info?" interstitial Instagram drops
 *                           you on immediately after a successful sign-in. Not in the
 *                           original spec; without it the very first login bounces.
 *   - `/accounts/password`— password reset, the other way back in.
 *   - `/challenge`        — verified live (HTTP 200): checkpoint / suspicious-login.
 *   - `/api`, `/graphql`, `/ajax`, `/static`
 *                         — Instagram's own XHR + asset paths. Subresource loads never
 *                           reach will-navigate, so these are belt-and-braces for the
 *                           cases that *do* navigate: iframed login widgets and
 *                           form posts.
 *
 * Deliberately absent: `/explore`, `/reels`, `/p/…`, `/stories`, and `/` itself —
 * the feed. Landing on `/` bounces to the DM inbox, which is the whole point.
 */
const INSTAGRAM_DM_PREFIXES = [
  "/direct",
  "/accounts/login",
  "/accounts/onetap",
  "/accounts/password",
  "/challenge",
  "/api",
  "/graphql",
  "/static",
  "/ajax",
];

export const SERVICES: Record<string, PanelService> = {
  instagram: {
    id: "instagram",
    label: "Instagram DMs",
    url: "https://www.instagram.com/direct/inbox/",
    partition: "persist:instagram",
    allowPathPrefixes: INSTAGRAM_DM_PREFIXES,
  },
  snapchat: {
    id: "snapchat",
    label: "Snapchat",
    // Snapchat retired web.snapchat.com as the app's home — it now redirects into the
    // marketing site, which is why the panel stopped landing on messaging (owner report
    // 2026-09-10). The web app proper lives at /web on the main domain.
    url: "https://www.snapchat.com/web",
    partition: "persist:snapchat",
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn messaging",
    url: "https://www.linkedin.com/messaging/",
    partition: "persist:linkedin",
  },
};

export const SERVICE_IDS = Object.keys(SERVICES);

/**
 * Electron's default UA advertises `POS/x` and `Electron/x` alongside Chrome. Snapchat
 * Web sniffs it and refuses to load ("Browser not supported") — Instagram and LinkedIn
 * do not care. Stripping those two tokens leaves a genuine Chrome UA string built from
 * this same Chromium, so we are not claiming a version we do not have.
 */
export function chromeUserAgent(defaultUa: string): string {
  return defaultUa
    .replace(/\s*(POS|pos)\/[^\s]+/g, "")
    .replace(/\s*Electron\/[^\s]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getService(id: string): PanelService | null {
  return Object.prototype.hasOwnProperty.call(SERVICES, id) ? SERVICES[id] : null;
}

// ── URL policy (pure — unit-tested without electron) ──────────────────────────

/**
 * What to do with a top-level navigation the panel is attempting.
 *   allow    — let it through
 *   bounce   — it's the service's own site but off-limits; send the view home
 *   external — a different site entirely; hand it to the real browser
 */
export type NavDecision = "allow" | "bounce" | "external";

/** eTLD+1-ish: last two labels. Fine for the .com services in SERVICES; a
 *  service on a multi-part TLD (example.co.uk) would need a real PSL. */
function baseDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

function sameSite(a: string, b: string): boolean {
  const da = baseDomain(a);
  return da !== "" && da === baseDomain(b);
}

export function decideNavigation(service: PanelService, url: string): NavDecision {
  let target: URL;
  let home: URL;
  try {
    target = new URL(url);
    home = new URL(service.url);
  } catch {
    return "bounce"; // unparseable — never hand it to the OS
  }
  // Anything that isn't the web (mailto:, itms-apps:, file:, custom handlers a
  // page can register) is refused outright rather than shelled out: shell.openExternal
  // on an attacker-chosen scheme is a launcher for arbitrary local apps.
  if (target.protocol !== "https:" && target.protocol !== "http:") return "bounce";
  if (!sameSite(target.hostname, home.hostname)) return "external";
  if (service.allowPathPrefixes) {
    const path = target.pathname || "/";
    if (!service.allowPathPrefixes.some((p) => path.startsWith(p))) return "bounce";
  }
  return "allow";
}

/** True only for URLs the panel may display itself. */
export function isAllowedUrl(service: PanelService, url: string): boolean {
  return decideNavigation(service, url) === "allow";
}

// ── panel state ───────────────────────────────────────────────────────────────

export interface PanelInfo {
  serviceId: string;
  label: string;
  url: string;
  bounds: Rectangle;
}

interface Panel {
  win: BrowserWindow;
  service: PanelService;
  view: WebContentsView;
  /** Last rect the renderer reported; re-applied on every window resize. */
  bounds: Rectangle;
  onResize: () => void;
  onClosed: () => void;
  /** Loop guard for the bounce-home redirect (see enforce()). */
  lastBounceAt: number;
}

// One panel at a time, app-wide. POS is a single-window app; a second panel would
// mean a second native view fighting for the same screen real estate.
let current: Panel | null = null;

const DEFAULT_WIDTH = 420;

function clamp(win: BrowserWindow, b: Rectangle): Rectangle {
  const [cw, ch] = win.getContentSize();
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(b.width), cw - x)),
    height: Math.max(0, Math.min(Math.round(b.height), ch - y)),
  };
}

function defaultBounds(win: BrowserWindow): Rectangle {
  const [cw, ch] = win.getContentSize();
  const width = Math.min(DEFAULT_WIDTH, Math.max(320, Math.floor(cw / 2)));
  return { x: Math.max(0, cw - width), y: 0, width, height: ch };
}

function apply(panel: Panel) {
  const b = clamp(panel.win, panel.bounds);
  panel.view.setBounds(b);
  // A zero-size rect means the renderer scrolled the reserved slot out of view.
  // setBounds alone would leave a 0×0 view still swallowing nothing; hiding is
  // what actually stops it painting a sliver at the edge.
  panel.view.setVisible(b.width > 0 && b.height > 0);
}

// ── navigation enforcement ────────────────────────────────────────────────────

/**
 * Confine the embedded view to the service (and, for Instagram, to Direct).
 *
 * HONEST SCOPE — read this before treating it as a control:
 * This constrains *this embedded surface only*. It is not a content blocker and
 * is not an account restriction. The owner can open Instagram in Safari, on his
 * phone, or in any other app, and nothing here notices or objects. What it buys
 * is that the panel POS puts on screen stays a DM client: no feed, no Reels, no
 * Explore one click away from the inbox. It removes the accident, not the option.
 *
 * Mechanism and its gaps:
 *   - `will-navigate` catches renderer-initiated document navigations (link clicks,
 *     form posts, location assignment).
 *   - `will-redirect` catches server 302s that would land somewhere off-limits.
 *   - `did-navigate-in-page` catches history.pushState — Instagram is a SPA and
 *     routes most of itself without a document load. This one fires *after* the
 *     fact, so a disallowed route can paint for a frame before the bounce. It is
 *     a correction, not a prevention.
 *   - In-page content that never changes the URL (a modal, an inline video) is not
 *     addressed at all. Nothing URL-shaped can be.
 */
function enforce(panel: Panel) {
  const { shell } = el();
  const wc = panel.view.webContents;
  const service = panel.service;

  const bounceHome = () => {
    // Guard against a bounce storm if home itself ever resolved somewhere blocked.
    const now = Date.now();
    if (now - panel.lastBounceAt < 1000) return;
    panel.lastBounceAt = now;
    void wc.loadURL(service.url, { userAgent: chromeUserAgent(wc.getUserAgent()) }).catch(() => {});
  };

  const handle = (url: string, isMainFrame: boolean, ev?: { preventDefault(): void }) => {
    if (!isMainFrame) return;
    const decision = decideNavigation(service, url);
    if (decision === "allow") return;
    ev?.preventDefault();
    if (decision === "external") {
      // A genuine link off the service — the system browser is where it belongs.
      void shell.openExternal(url).catch(() => {});
      return;
    }
    bounceHome(); // same site, off-limits path: back to the messages
  };

  wc.on("will-navigate", (details) => handle(details.url, details.isMainFrame, details));
  wc.on("will-redirect", (details) => handle(details.url, details.isMainFrame, details));
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (decideNavigation(service, url) !== "allow") bounceHome();
  });

  // No popups, ever. `window.open` from a third-party page is how you end up with
  // an un-enforced window outside the panel; genuine external links go to the OS.
  wc.setWindowOpenHandler((details: HandlerDetails) => {
    const decision = decideNavigation(service, details.url);
    if (decision === "external") void shell.openExternal(details.url).catch(() => {});
    else if (decision === "allow") void wc.loadURL(details.url, { userAgent: chromeUserAgent(wc.getUserAgent()) }).catch(() => {});
    // "bounce": swallow it — the panel stays where it is.
    return { action: "deny" as const };
  });

  // These are third-party sites in their own sessions, so the app's default-session
  // permission handler (main/index.ts) does not cover them. Deny everything except
  // the clipboard write a "copy link" button needs; macOS TCC is a second gate, but
  // relying on it would mean the OS prompt is the *first* time anyone says no.
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });
  wc.session.setPermissionCheckHandler((_wc, permission) => permission === "clipboard-sanitized-write");
}

// ── public API ────────────────────────────────────────────────────────────────

export function openPanel(win: BrowserWindow, serviceId: string, bounds?: Rectangle): PanelInfo {
  const service = getService(serviceId);
  if (!service) throw new Error(`unknown_service: ${serviceId}`);

  // Same service, same window → just re-show it rather than dropping the session
  // mid-scroll (and mid-login).
  if (current && current.win === win && current.service.id === service.id && !current.view.webContents.isDestroyed()) {
    if (bounds) current.bounds = bounds;
    apply(current);
    return info(current);
  }
  closePanel(win);

  const { WebContentsView } = el();
  const view = new WebContentsView({
    webPreferences: {
      partition: service.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // NO preload. These are third-party pages; they must never see `window.pos`,
      // which is a fully-privileged handle on the owner's contacts, mail and calendar.
    },
  });
  view.setBackgroundColor("#ffffff");
  // Match the renderer's rounded slot — a square native view over a rounded hole
  // is the tell that gives away that this isn't really "in" the app.
  try {
    view.setBorderRadius(12);
  } catch {
    /* older Electron without setBorderRadius — cosmetic only */
  }

  const panel: Panel = {
    win,
    service,
    view,
    bounds: bounds ? bounds : defaultBounds(win),
    onResize: () => {},
    onClosed: () => {},
    lastBounceAt: 0,
  };
  // The renderer's ResizeObserver reports the rect, but a native window resize
  // can land before React re-measures — re-apply the last rect immediately so the
  // view never hangs off the edge for a frame.
  panel.onResize = () => apply(panel);
  panel.onClosed = () => closePanel(win);
  win.on("resize", panel.onResize);
  win.once("closed", panel.onClosed);

  enforce(panel);
  win.contentView.addChildView(view);
  current = panel;
  apply(panel);
  // Present as plain Chrome — see chromeUserAgent(). Set before the first load so the
  // very first request already carries it.
  try {
    view.webContents.setUserAgent(chromeUserAgent(view.webContents.getUserAgent()));
  } catch {
    /* non-fatal: worst case the site sees the Electron UA it would have seen anyway */
  }
  const ua = chromeUserAgent(view.webContents.getUserAgent());
  void view.webContents.loadURL(service.url, { userAgent: ua }).catch(() => {});
  return info(panel);
}

export function closePanel(win?: BrowserWindow): void {
  const panel = current;
  if (!panel) return;
  if (win && panel.win !== win) return;
  current = null;
  try {
    if (!panel.win.isDestroyed()) {
      panel.win.removeListener("resize", panel.onResize);
      panel.win.removeListener("closed", panel.onClosed);
      panel.win.contentView.removeChildView(panel.view);
    }
  } catch {
    /* window already torn down */
  }
  try {
    if (!panel.view.webContents.isDestroyed()) panel.view.webContents.close();
  } catch {
    /* already gone */
  }
}

export function resizePanel(win: BrowserWindow, bounds: Rectangle): PanelInfo | null {
  if (!current || current.win !== win) return null;
  current.bounds = bounds;
  apply(current);
  return info(current);
}

export function currentPanel(): PanelInfo | null {
  if (!current) return null;
  if (current.view.webContents.isDestroyed()) {
    current = null;
    return null;
  }
  return info(current);
}

function info(panel: Panel): PanelInfo {
  return {
    serviceId: panel.service.id,
    label: panel.service.label,
    url: panel.service.url,
    bounds: panel.bounds,
  };
}
