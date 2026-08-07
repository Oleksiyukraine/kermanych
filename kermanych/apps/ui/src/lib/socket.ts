// apps/ui/src/lib/socket.ts
// Socket.IO client to the Kermanych API. Server emits ServerEvent objects on
// the "event" channel: a {type:"snapshot",...} on connect, then live events.
import { io, type Socket } from 'socket.io-client';
import type { ServerEvent } from '@kermanych/core';

const URL = 'http://localhost:4317';

export type ServerEventHandler = (e: ServerEvent) => void;

/**
 * Connect to the API and forward every ServerEvent from the "event" channel
 * to `handler`. Reconnection is handled by socket.io for free.
 */
export function connectSocket(handler: ServerEventHandler): Socket {
  const socket = io(URL);
  socket.on('event', (e: ServerEvent) => handler(e));
  return socket;
}
