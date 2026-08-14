// apps/ui/src/lib/socket.ts
// Socket.IO client to the Kermanych API. Server emits ServerEvent objects on
// the "event" channel: a {type:"snapshot",...} on connect, then live events.
import { io, type Socket } from 'socket.io-client';
import type { ServerEvent } from '@kermanych/core';

const URL =
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

/**
 * Connect to the API and forward every ServerEvent from the "event" channel to
 * `handler`. socket.io reconnects on a clean drop for free; {@link installVisibilityResync}
 * covers the silent-death-after-sleep case the built-in reconnect misses.
 */
export function connectSocket(handler: ServerEventHandler): Socket {
  const socket = io(URL);
  socket.on('event', (e: ServerEvent) => handler(e));
  if (typeof document !== 'undefined') installVisibilityResync(socket, document);
  return socket;
}
