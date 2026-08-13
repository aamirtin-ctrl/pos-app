// Typed window.pos surface (mirrors preload/index.ts). All calls resolve to
// { ok: true, data } | { ok: false, error }.

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

type Call<T = unknown> = (...args: unknown[]) => Promise<IpcResult<T>>;

/**
 * What `plan.accept` and `plan.push` report. `error` is a typed string, not a Google
 * message: "reconsent_required" (the stored grant predates POS's calendar-write scope —
 * the owner must re-authorize), "not_connected", "auto_push_off", or a raw failure.
 */
export interface PlanPushResult {
  pushed: number;
  tasks: number;
  /** Stale events withdrawn from Google — blocks a re-plan removed. */
  withdrawn: number;
  error?: string;
}

/**
 * `llm.health` (main/llm/provider.ts): whether the next AI call would actually reach a
 * model. `ok: false` means the app is running its deterministic fallbacks — event titles
 * copied verbatim instead of rewritten, keyword-rule extraction — which is otherwise
 * indistinguishable from working normally.
 */
export interface LlmHealth {
  provider: "anthropic" | "gemini" | null;
  configured: boolean;
  ok: boolean;
  reason?: "no_key" | "quota" | "ceiling" | "error";
  lastFailureAt?: string;
  monthSpend: number;
  ceiling: number;
}

/** `gcal.scopeStatus`: canWrite is false when the grant cannot create calendars. */
export interface GoogleScopeStatus {
  connected: boolean;
  hasCreds: boolean;
  canWrite: boolean;
}

/**
 * `hotkey.get` / `hotkey.set` (main/index.ts globalShortcut, validated in main/ipc.ts).
 * `registered: false` always carries an `error` — a shortcut another app already owns,
 * one whose only modifier is Shift, or one using Fn (which macOS never reports to apps),
 * must be visible rather than silently inert.
 */
export interface HotkeyState {
  accelerator: string;
  registered: boolean;
  error?: string;
}

/**
 * `hud.result`: the floating voice HUD telling main its capture is over. "cancelled" is
 * Escape or a click on the HUD — nothing was sent to the assistant.
 */
export interface HudResult {
  status: "done" | "cancelled" | "error";
  text?: string;
  reply?: string;
}

/** A rect in CSS pixels, relative to the window's content area (main/webpanel.ts). */
export interface PanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `panel.open` / `panel.bounds` / `panel.current`: the docked in-app browser. Only
 * one panel exists at a time, so `current` is null or the single open one.
 */
export interface PanelInfo {
  serviceId: string;
  label: string;
  url: string;
  bounds: PanelBounds;
}

/** `panel.services`: dmOnly means the panel confines that site to its DM surface. */
export interface PanelServiceInfo {
  id: string;
  label: string;
  dmOnly: boolean;
}

declare global {
  interface Window {
    pos: {
      people: {
        list: Call; get: Call; patch: Call; patchWithExtract: Call; merge: Call; delete: Call;
        reconnect: Call; dismissReconnect: Call; undismissReconnect: Call; exportCsv: Call;
      };
      query: { rank: Call };
      review: {
        pending: Call; keep: Call; discard: Call; group: Call;
        mergeCluster: Call; dismissDuplicates: Call;
        resolveAmbiguous: Call; dismissAmbiguous: Call;
        resolveNoteChunk: Call; dismissNoteChunk: Call;
      };
      groups: {
        list: Call; create: Call; rename: Call; delete: Call;
        assign: Call; assignMany: Call; remove: Call;
        hide: Call; hideContacts: Call; suppressFollowUps: Call;
      };
      commitments: { list: Call; confirm: Call; drop: Call; schedule: Call; toTask: Call; toEvent: Call; updateText: Call };
      tasks: { braindump: Call; list: Call; setStatus: Call; strip: Call };
      plan: { generate: Call; get: Call; accept: Call; push: Call; moveBlock: Call; resizeBlock: Call; moveBlockToDay: Call; unpinBlock: Call };
      outcomes: { needed: Call; capture: Call; adherence: Call };
      sync: { run: Call; status: Call; embed: Call; pickAndRun: Call };
      mail: { list: Call; add: Call; remove: Call; connectOAuth: Call };
      gcal: { connect: Call; cancel: Call; connected: Call; scopeStatus: Call; reconcile: Call; events: Call };
      ics: { list: Call; add: Call; remove: Call };
      notion: {
        available: Call; targets: Call; setParent: Call; sync: Call;
        pages: Call; page: Call; append: Call; check: Call; createPage: Call;
        rows: Call; updateBlock: Call; deleteBlock: Call;
      };
      applecal: { available: Call; calendars: Call; events: Call; mirror: Call; deleteEvent: Call };
      calendar: { deleteEvent: Call; moveEvent: Call };
      reminders: { available: Call; lists: Call; list: Call; sync: Call; complete: Call };
      gtasks: { purgePreview: Call; purgeApply: Call };
      /** Cross-source calendar ops for the day view (Google + Apple aware). */
      calendar: { deleteEvent: Call; moveEvent: Call };
      settings: {
        keys: Call; setKey: Call; doctrineGet: Call; doctrineSet: Call;
        spend: Call; setCeiling: Call; get: Call; set: Call;
      };
      /**
       * The system-wide accelerator that opens the floating listener HUD with the mic
       * live — without bringing POS forward or taking keyboard focus.
       */
      hotkey: { get: Call<HotkeyState>; set: Call<HotkeyState> };
      /** HUD-only: "my capture is over, hide me". See HudResult. */
      hud: { result: Call<{ hidden: boolean }> };
      /**
       * Fired when that accelerator is pressed, from any app. Delivered to the HUD
       * window, which treats each one as a toggle. Returns its unsubscribe.
       */
      onVoiceCapture: (cb: () => void) => () => void;
      onDayChanged: (cb: (dateISO: string) => void) => () => void;
      /** Provider reachability — see LlmHealth above. */
      llm: { health: Call<LlmHealth> };
      msgplans: { run: Call; list: Call };
      digest: { send: Call; preview: Call };
      capture: { senders: Call };
      screentime: { available: Call; diagnostics: Call; block: Call; autoCapture: Call };
      undo: { do: Call; redo: Call };
      worklog: { list: Call; add: Call; catchUp: Call };
      context: { list: Call; set: Call; delete: Call; resolveDate: Call };
      /** The user-owned preferences.md next to doctrine.yaml (main/preferences.ts). */
      prefs: { get: Call; set: Call; reveal: Call };
      assistant: { command: Call };
      stt: { transcribe: Call };
      inbox: { list: Call; sendEmail: Call; sendIMessage: Call; sendIMessageChat: Call; handles: Call };
      drafts: { list: Call; generate: Call; setStatus: Call };
      voice: { synthesize: Call; get: Call };
      /**
       * Docked in-app web browser panel. `open` and `bounds` act on the window that
       * called them; `bounds` returns null when no panel is open.
       */
      panel: {
        open: Call<PanelInfo>;
        close: Call<{ closed: boolean }>;
        bounds: Call<PanelInfo | null>;
        current: Call<PanelInfo | null>;
        services: Call<PanelServiceInfo[]>;
      };
      app: { openFullDiskAccess: Call; openLinkedIn: Call };
    };
  }
}

export {};
