// contextBridge: the ONLY surface the renderer can reach. Mirrors main/ipc.ts.

import { contextBridge, ipcRenderer } from "electron";

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("pos", {
  people: {
    list: call("people.list"),
    get: call("people.get"),
    patch: call("people.patch"),
    merge: call("people.merge"),
    reconnect: call("people.reconnect"),
  },
  query: { rank: call("query.rank") },
  groups: {
    list: call("groups.list"),
    create: call("groups.create"),
    assign: call("groups.assign"),
    remove: call("groups.remove"),
    hide: call("groups.hide"),
  },
  commitments: {
    list: call("commitments.list"),
    schedule: call("commitments.schedule"),
    updateText: call("commitments.updateText"),
    confirm: call("commitments.confirm"),
    drop: call("commitments.drop"),
    toTask: call("commitments.toTask"),
    toEvent: call("commitments.toEvent"),
  },
  tasks: {
    braindump: call("tasks.braindump"),
    list: call("tasks.list"),
    setStatus: call("tasks.setStatus"),
  },
  plan: {
    generate: call("plan.generate"),
    get: call("plan.get"),
    accept: call("plan.accept"),
    push: call("plan.push"),
  },
  outcomes: {
    needed: call("outcomes.needed"),
    capture: call("outcomes.capture"),
    adherence: call("outcomes.adherence"),
  },
  sync: {
    run: call("sync.run"),
    status: call("sync.status"),
    embed: call("sync.embed"),
    pickAndRun: call("sync.pickAndRun"),
  },
  mail: {
    list: call("mail.accounts.list"),
    add: call("mail.accounts.add"),
    remove: call("mail.accounts.remove"),
  },
  gcal: { connect: call("gcal.connect"), cancel: call("gcal.cancel"), connected: call("gcal.connected"), reconcile: call("gcal.reconcile"), events: call("gcal.events") },
  applecal: {
    available: call("applecal.available"),
    calendars: call("applecal.calendars"),
    events: call("applecal.events"),
    mirror: call("applecal.mirror"),
  },
  settings: {
    keys: call("settings.keys"),
    setKey: call("settings.setKey"),
    doctrineGet: call("settings.doctrine.get"),
    doctrineSet: call("settings.doctrine.set"),
    spend: call("settings.spend"),
    setCeiling: call("settings.setCeiling"),
    get: call("settings.get"),
    set: call("settings.set"),
  },
  msgplans: { run: call("msgplans.run"), list: call("msgplans.list") },
  assistant: { command: call("assistant.command") },
  stt: { transcribe: call("stt.transcribe") },
  inbox: {
    list: call("inbox.list"),
    sendEmail: call("inbox.sendEmail"),
    sendIMessage: call("inbox.sendIMessage"),
    handles: call("inbox.handles"),
  },
  drafts: { list: call("drafts.list"), generate: call("drafts.generate"), setStatus: call("drafts.setStatus") },
  voice: { synthesize: call("voice.synthesize"), get: call("voice.get") },
  app: { openFullDiskAccess: call("app.openFullDiskAccess"), openLinkedIn: call("app.openLinkedIn") },
});
