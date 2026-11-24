// The phone's whole state: its key, the computer's reachability, the session list and the opened
// conversations. One module-level reactive object — the app has two screens and no store library.
//
// Data flow (docs/plans/2026-11-24-mobile-remote-control.md → Remote server): GET /sessions (and
// /me) first, then the socket keeps everything live — `list` on every connect, `session` /
// `session_removed`, and transcript events of listed sessions. A transcript is fetched when its
// session is opened; events that land while that fetch runs are held and replayed on top of it.
//
// Reachability (spec → «Комп'ютер недоступний», «На комп'ютері не виконано вхід»):
//   unauthorized  → the key is gone or lapsed: forget it and pair again;
//   signed_out    → banner; retried every RETRY_MS until someone signs in on the computer;
//   foreign_login → banner; the phone is on another tailnet login;
//   network       → banner; socket.io reconnects by itself, the banner offers «Спробувати ще».

import { reactive } from "vue";
import { io, type Socket } from "socket.io-client";
import { REMOTE_SOCKET_PATH } from "@kermanych/core/remote";
import type {
  RemoteEvent,
  RemoteList,
  RemoteMe,
  RemoteProject,
  RemotePushSubscription,
  RemoteSession,
  RpcExtensionUIResponse,
  TranscriptEntry,
} from "@kermanych/core";
import { ApiError, api, isRemoteErrorCode, readKey, writeKey } from "./api";
import { t } from "./i18n";

export type Link = "ok" | "offline" | "signed_out" | "foreign_login";

type State = {
  key: string | null;
  /** Why the pairing screen is back (the computer forgot this phone). */
  pairNotice: string | null;
  me: RemoteMe | null;
  projects: RemoteProject[];
  /** `undefined` until the first list arrived — never an empty state before that. */
  sessions: Map<string, RemoteSession> | undefined;
  /** Conversations of opened sessions; absent = not fetched yet. */
  transcripts: Map<string, TranscriptEntry[]>;
  link: Link;
  /** The socket is up: live updates flow. */
  live: boolean;
};

export const state = reactive<State>({
  key: readKey(),
  pairNotice: null,
  me: null,
  projects: [],
  sessions: undefined,
  transcripts: new Map(),
  link: "ok",
  live: false,
});

/** A refused socket handshake is not retried by socket.io; the phone retries it this often. */
const RETRY_MS = 10_000;

let socket: Socket | undefined;
let retryTimer: number | undefined;
/** Transcript events that arrived while that session's GET was in flight. */
const held = new Map<string, TranscriptEvent[]>();

type TranscriptEvent = Extract<RemoteEvent, { type: "transcript_append" | "transcript_reset" | "transcript_update" }>;

// ── Errors ──────────────────────────────────────────────────────────────────

/** What every failed call passes through: the banners and the forced re-pairing live here. */
function noteError(e: unknown): void {
  if (!(e instanceof ApiError)) return;
  if (e.code === "unauthorized") forget(t("pair.forgotten"));
  else if (e.code === "signed_out") state.link = "signed_out";
  else if (e.code === "foreign_login") state.link = "foreign_login";
  else if (e.code === "network") state.link = "offline";
}

/** The computer answered: whatever banner was up no longer applies. */
function reached(): void {
  state.link = "ok";
}

/**
 * Runs one api call with the current key; any refusal updates the banners, then rethrows. An
 * answer for a key that is no longer the phone's (forgotten, or replaced by re-pairing while
 * the call ran) says nothing about the current one, so it touches no banner and no key.
 */
async function withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
  const key = state.key;
  if (!key) throw new ApiError("unauthorized", t("error.unauthorized"), 401);
  try {
    const out = await fn(key);
    if (state.key === key) reached();
    return out;
  } catch (e) {
    if (state.key === key) noteError(e);
    throw e;
  }
}

// ── Key lifecycle ───────────────────────────────────────────────────────────

export function paired(key: string): void {
  writeKey(key);
  state.key = key;
  state.pairNotice = null;
  start();
}

export function forget(notice: string | null): void {
  writeKey(null);
  state.key = null;
  state.pairNotice = notice;
  stopSocket();
  state.me = null;
  state.projects = [];
  state.sessions = undefined;
  state.transcripts = new Map();
  state.link = "ok";
}

/** Connects with the stored key: socket first (it sends `list` on connect), HTTP alongside. */
export function start(): void {
  if (!state.key) return;
  connectSocket(state.key);
  void refresh();
}

/** The HTTP re-read in flight, and the key it was made with. */
let refreshing: { key: string | null; promise: Promise<void> } | undefined;

/** Re-reads `me` and the list over HTTP (start, «Спробувати ще», a late first connect); one per key at a time. */
export function refresh(): Promise<void> {
  if (refreshing && refreshing.key === state.key) return refreshing.promise;
  const key = state.key;
  // The entry this run owns: `finally` clears `refreshing` only while it is still this run's.
  const entry = { key } as { key: string | null; promise: Promise<void> };
  entry.promise = (async () => {
    try {
      const [me, list] = await withKey((k) => Promise.all([api.me(k), api.sessions(k)]));
      // A late answer for a key forgotten (or replaced by re-pairing) meanwhile is dropped.
      if (state.key !== key) return;
      state.me = me;
      applyList(list);
    } catch {
      // noteError already raised the banner or sent the phone back to pairing.
    } finally {
      if (refreshing === entry) refreshing = undefined;
    }
  })();
  refreshing = entry;
  return entry.promise;
}

/** «Спробувати ще»: kick the socket now instead of after its backoff, and re-read over HTTP. */
export async function retry(): Promise<void> {
  if (socket && !socket.connected) {
    clearTimeout(retryTimer);
    socket.connect();
  }
  await refresh();
}

// ── Socket ──────────────────────────────────────────────────────────────────

function connectSocket(key: string): void {
  stopSocket();
  const s = io({
    path: REMOTE_SOCKET_PATH,
    auth: { key },
    transports: ["websocket", "polling"],
    reconnectionDelay: 1_000,
    reconnectionDelayMax: RETRY_MS,
  });
  socket = s;
  s.on("connect", () => {
    state.live = true;
    reached();
    // Events missed while away: the `list` that follows refreshes the rows; conversations
    // already on screen are re-read (a failure there already raised its banner in withKey).
    for (const id of state.transcripts.keys()) void loadTranscript(id).catch(() => undefined);
    // Connected after a refused start (signed out, offline): `me` was never read.
    if (!state.me) void refresh();
  });
  s.on("disconnect", (reason) => {
    state.live = false;
    if (reason === "io client disconnect") return;
    if (reason === "io server disconnect") {
      // The server dropped this phone on purpose: «Відключити» on the computer, or a lapsed
      // key. Ask once over HTTP — a 401 sends the phone to pairing, anything else reconnects.
      void (async () => {
        try {
          await withKey((k) => api.me(k));
          if (socket === s) s.connect();
        } catch {
          if (socket === s && state.key) scheduleRetry(s);
        }
      })();
      return;
    }
    state.link = "offline";
  });
  s.on("connect_error", (err: Error) => {
    state.live = false;
    // The server's io middleware refuses with `new Error(code)` carrying `data: RemoteError`.
    const data = (err as Error & { data?: { code?: unknown } }).data;
    const code = isRemoteErrorCode(data?.code) ? data.code : isRemoteErrorCode(err.message) ? err.message : undefined;
    if (code === "unauthorized") return forget(t("pair.forgotten"));
    if (code === "signed_out") state.link = "signed_out";
    else if (code === "foreign_login") state.link = "foreign_login";
    else state.link = "offline";
    // A transport failure is retried by socket.io itself (`active`); a refusal is not.
    if (!s.active) scheduleRetry(s);
  });
  s.on("event", (ev: RemoteEvent) => onEvent(ev));
}

function scheduleRetry(s: Socket): void {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    if (socket === s && !s.connected) s.connect();
  }, RETRY_MS);
}

function stopSocket(): void {
  clearTimeout(retryTimer);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = undefined;
  state.live = false;
}

/** iOS freezes a backgrounded web app and its socket; coming back reconnects at once. */
export function resume(): void {
  if (!state.key) return;
  if (!socket) return start();
  if (!socket.connected) {
    clearTimeout(retryTimer);
    socket.connect();
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function applyList(list: RemoteList): void {
  state.projects = list.projects;
  state.sessions = new Map(list.sessions.map((s) => [s.id, s]));
  // Conversations of sessions no longer listed are dropped with them.
  for (const id of [...state.transcripts.keys()]) if (!state.sessions.has(id)) state.transcripts.delete(id);
}

function onEvent(ev: RemoteEvent): void {
  switch (ev.type) {
    case "list":
      return applyList(ev);
    case "session":
      // Before the first list a lone row would pass for the whole list; `list` follows on connect.
      state.sessions?.set(ev.session.id, ev.session);
      return;
    case "session_removed":
      state.sessions?.delete(ev.sessionId);
      state.transcripts.delete(ev.sessionId);
      return;
    default: {
      const pending = held.get(ev.sessionId);
      if (pending) {
        pending.push(ev);
        return;
      }
      const entries = state.transcripts.get(ev.sessionId);
      if (entries) state.transcripts.set(ev.sessionId, applyTranscriptEvent(entries, ev));
    }
  }
}

function applyTranscriptEvent(entries: TranscriptEntry[], ev: TranscriptEvent): TranscriptEntry[] {
  if (ev.type === "transcript_reset") return ev.entries;
  if (ev.type === "transcript_append") {
    // An entry re-sent with the same id (a streaming text that grew) replaces its earlier copy.
    const at = entries.findIndex((e) => e.id === ev.entry.id);
    if (at < 0) return [...entries, ev.entry];
    const next = entries.slice();
    next[at] = ev.entry;
    return next;
  }
  const at = entries.findIndex((e) => e.id === ev.id && e.kind === "tool");
  if (at < 0) return entries;
  const tool = entries[at] as Extract<TranscriptEntry, { kind: "tool" }>;
  const next = entries.slice();
  next[at] = {
    ...tool,
    status: ev.status,
    ...(ev.target !== undefined ? { target: ev.target } : {}),
    ...(ev.stat !== undefined ? { stat: ev.stat } : {}),
    ...(ev.count !== undefined ? { count: ev.count } : {}),
    ...(ev.ms !== undefined ? { ms: ev.ms } : {}),
    ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
  };
  return next;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Fetches one conversation; live events arriving meanwhile are replayed over the answer. */
export async function loadTranscript(id: string): Promise<void> {
  if (held.has(id)) return;
  held.set(id, []);
  try {
    let entries = await withKey((key) => api.transcript(key, id));
    for (const ev of held.get(id) ?? []) entries = applyTranscriptEvent(entries, ev);
    state.transcripts.set(id, entries);
  } finally {
    held.delete(id);
  }
}

export const actions = {
  message: (id: string, text: string, images: { data: string; mimeType: string }[]) =>
    withKey((key) => api.message(key, id, { text, ...(images.length ? { images } : {}) })),
  answer: (id: string, res: RpcExtensionUIResponse) => withKey((key) => api.answer(key, id, res)),
  stop: (id: string) => withKey((key) => api.stop(key, id)),
  pushOn: (sub: RemotePushSubscription) => withKey((key) => api.pushOn(key, sub)),
  pushOff: () => withKey((key) => api.pushOff(key)),
};
