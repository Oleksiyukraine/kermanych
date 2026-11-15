// apps/ui/src/lib/socket.ts
// Socket.IO client to the Kermanych API. Server emits ServerEvent objects on
// the "event" channel: a {type:"snapshot",...} on connect, then live events.
import { io, type Socket } from 'socket.io-client';
import type { ServerEvent } from '@kermanych/core';
import { getAuthToken } from './api';

// The API's origin (the REST base without `/api`) — socket.io namespaces hang off it:
// the default one here, `/terminal` in stores/terminal.ts.
export const SOCKET_ORIGIN =
  ((typeof window !== 'undefined' && window.kermanych?.apiBase) ||
    (import.meta.env.VITE_API_BASE ?? 'http://localhost:4317/api')).replace(/\/api\/?$/, '') ||
  'http://localhost:4317';

export type ServerEventHandler = (e: ServerEvent) => void;

/** Minimal socket surface {@link installVisibilityResync} needs — lets tests inject a fake. */
export interface ResyncSocket {
  readonly disconnected: boolean;
  connect(): unknown;
  disconnect(): unknown;
}

/** Minimal document surface — lets tests drive visibility without a real DOM. */
export interface VisibilityDoc {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Force a reconnect when the tab returns to the foreground after a long hide.
 *
 * The gap this closes: a laptop sleep (or any long background) can leave the
 * transport silently dead — socket.io keeps thinking it is connected, so a
 * session_update emitted meanwhile (e.g. a turn finishing) is missed and the UI
 * stays stale forever ("Думаю…" on an agent that is actually done). The server
 * re-emits a full {type:"snapshot"} on every (re)connect, so forcing a reconnect
 * on return re-syncs the whole store. A brief tab-flip is left untouched.
 *
 * `now`/`staleHideMs` are injectable for tests.
 */
export function installVisibilityResync(
  socket: ResyncSocket,
  doc: VisibilityDoc,
  { staleHideMs = 10_000, now = Date.now }: { staleHideMs?: number; now?: () => number } = {},
): void {
  let hiddenAt = 0;
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      hiddenAt = now();
      return;
    }
    if (socket.disconnected) {
      socket.connect(); // transport socket.io already gave up on — revive it
    } else if (hiddenAt && now() - hiddenAt > staleHideMs) {
      // Still "connected" after a long hide: likely a stale socket that outlived a
      // sleep. Cycle it so the server replays a fresh snapshot and the store re-syncs.
      socket.disconnect();
      socket.connect();
    }
    hiddenAt = 0;
  });
}

/** Minimal socket surface {@link installRefusalRetry} needs — lets tests inject a fake. */
export interface RetrySocket {
  readonly active: boolean;
  readonly connected: boolean;
  connect(): unknown;
  on(event: 'connect' | 'connect_error', listener: () => void): unknown;
}

/**
 * Revive the socket after the api refused its handshake.
 *
 * The api admits only the bearer the ui handed it (apps/api/src/ws/events.gateway.ts), and
 * socket.io never retries a handshake the server refused: `socket.active` turns false and the
 * socket stays down. That happens when the socket connects ahead of the token's handoff — the
 * api was still booting, or a refreshed token is not accepted yet — and without a retry the
 * board would never see another event. A dropped transport (`active` still true) is left to
 * socket.io's own reconnect. The handshake reads the token on every attempt, so a retry
 * presents the current one. A retry that finds the socket already (re)connecting does nothing.
 */
export function installRefusalRetry(
  socket: RetrySocket,
  { minMs = 1_000, maxMs = 15_000 }: { minMs?: number; maxMs?: number } = {},
): void {
  let delay = minMs;
  socket.on('connect', () => {
    delay = minMs;
  });
  socket.on('connect_error', () => {
    if (socket.active) return;
    setTimeout(() => {
      if (!socket.connected && !socket.active) socket.connect();
    }, delay);
    delay = Math.min(delay * 2, maxMs);
  });
}

/**
 * Connect to the API and forward every ServerEvent from the "event" channel to
 * `handler`. The handshake carries the operator's bearer, read on every (re)connect so a
 * refreshed token is the one presented. socket.io reconnects on a clean drop for free;
 * {@link installRefusalRetry} covers a refused handshake and {@link installVisibilityResync}
 * the silent-death-after-sleep case the built-in reconnect misses.
 */
export function connectSocket(handler: ServerEventHandler): Socket {
  const socket = io(SOCKET_ORIGIN, { auth: (cb) => cb({ token: getAuthToken() }) });
  socket.on('event', (e: ServerEvent) => handler(e));
  installRefusalRetry(socket);
  if (typeof document !== 'undefined') installVisibilityResync(socket, document);
  return socket;
}
