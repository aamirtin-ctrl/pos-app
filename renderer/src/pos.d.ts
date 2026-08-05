// Typed window.pos surface (mirrors preload/index.ts). All calls resolve to
// { ok: true, data } | { ok: false, error }.

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

type Call<T = unknown> = (...args: unknown[]) => Promise<IpcResult<T>>;

declare global {
  interface Window {
    pos: {
      people: {
        list: Call; get: Call; patch: Call; patchWithExtract: Call; merge: Call; delete: Call;
        reconnect: Call; dismissReconnect: Call; undismissReconnect: Call; exportCsv: Call;
      };
      query: { rank: Call };
      groups: {
        list: Call; create: Call; rename: Call; delete: Call;
        assign: Call; assignMany: Call; remove: Call;
        hide: Call; hideContacts: Call; suppressFollowUps: Call;
      };
      commitments: { list: Call; confirm: Call; drop: Call; schedule: Call; toTask: Call; toEvent: Call; updateText: Call };
      tasks: { braindump: Call; list: Call; setStatus: Call };
      plan: { generate: Call; get: Call; accept: Call; push: Call };
      outcomes: { needed: Call; capture: Call; adherence: Call };
      sync: { run: Call; status: Call; embed: Call; pickAndRun: Call };
      mail: { list: Call; add: Call; remove: Call; connectOAuth: Call };
      gcal: { connect: Call; cancel: Call; connected: Call; reconcile: Call; events: Call };
      ics: { list: Call; add: Call; remove: Call };
      notion: { available: Call; targets: Call; setParent: Call; sync: Call };
      applecal: { available: Call; calendars: Call; events: Call; mirror: Call };
      settings: {
        keys: Call; setKey: Call; doctrineGet: Call; doctrineSet: Call;
        spend: Call; setCeiling: Call; get: Call; set: Call;
      };
      msgplans: { run: Call; list: Call };
      digest: { send: Call; preview: Call };
      undo: { do: Call; redo: Call };
      worklog: { list: Call; add: Call; catchUp: Call };
      context: { list: Call; set: Call; delete: Call; resolveDate: Call };
      assistant: { command: Call };
      stt: { transcribe: Call };
      inbox: { list: Call; sendEmail: Call; sendIMessage: Call; sendIMessageChat: Call; handles: Call };
      drafts: { list: Call; generate: Call; setStatus: Call };
      voice: { synthesize: Call; get: Call };
      app: { openFullDiskAccess: Call; openLinkedIn: Call };
    };
  }
}

export {};
