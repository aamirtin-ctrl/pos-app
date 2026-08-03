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
      people: { list: Call; get: Call; patch: Call; merge: Call; reconnect: Call };
      query: { rank: Call };
      groups: { list: Call; create: Call; assign: Call; remove: Call; hide: Call };
      commitments: { list: Call; confirm: Call; drop: Call; schedule: Call };
      tasks: { braindump: Call; list: Call; setStatus: Call };
      plan: { generate: Call; get: Call; accept: Call; push: Call };
      outcomes: { needed: Call; capture: Call; adherence: Call };
      sync: { run: Call; status: Call; embed: Call; pickAndRun: Call };
      mail: { list: Call; add: Call; remove: Call };
      gcal: { connect: Call; connected: Call; reconcile: Call; events: Call };
      settings: {
        keys: Call; setKey: Call; doctrineGet: Call; doctrineSet: Call;
        spend: Call; setCeiling: Call; get: Call; set: Call;
      };
      assistant: { command: Call };
      stt: { transcribe: Call };
      drafts: { list: Call; generate: Call; setStatus: Call };
      voice: { synthesize: Call; get: Call };
      app: { openFullDiskAccess: Call };
    };
  }
}

export {};
