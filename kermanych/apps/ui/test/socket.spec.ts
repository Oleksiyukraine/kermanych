import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  installRefusalRetry,
  installVisibilityResync,
  type ResyncSocket,
  type RetrySocket,
  type VisibilityDoc,
} from '../src/lib/socket';

// A document stand-in whose visibility we can flip, firing the one registered
// 'visibilitychange' listener — no real DOM needed.
function fakeDoc() {
  let vs: DocumentVisibilityState = 'visible';
  let listener: (() => void) | undefined;
  return {
    get visibilityState() {
      return vs;
    },
    addEventListener(_type: 'visibilitychange', cb: () => void) {
      listener = cb;
    },
    flip(v: DocumentVisibilityState) {
      vs = v;
      listener?.();
    },
  };
}

function fakeSocket(disconnected = false) {
  return { disconnected, connect: vi.fn(), disconnect: vi.fn() };
}

describe('installVisibilityResync', () => {
  it('forces a reconnect when the tab returns after a long hide (stale socket)', () => {
    const socket = fakeSocket(false);
    const doc = fakeDoc();
    let t = 0;
    installVisibilityResync(socket as ResyncSocket, doc as unknown as VisibilityDoc, {
      staleHideMs: 10_000,
      now: () => t,
    });

    t = 1_000;
    doc.flip('hidden');
    t = 30_000; // hidden for 29s, well past the 10s stale threshold
    doc.flip('visible');

    // A stale-but-"connected" socket is cycled so the server replays its snapshot.
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves a healthy socket untouched on a brief tab-flip', () => {
    const socket = fakeSocket(false);
    const doc = fakeDoc();
    let t = 0;
    installVisibilityResync(socket as ResyncSocket, doc as unknown as VisibilityDoc, {
      staleHideMs: 10_000,
      now: () => t,
    });

    t = 1_000;
    doc.flip('hidden');
    t = 3_000; // hidden for only 2s — Alt+Tab, not a sleep
    doc.flip('visible');

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('revives an already-disconnected socket on return without cycling it', () => {
    const socket = fakeSocket(true); // socket.io already gave up on the transport
    const doc = fakeDoc();
    installVisibilityResync(socket as ResyncSocket, doc as unknown as VisibilityDoc, {
      now: () => 0,
    });

    doc.flip('visible');

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

// A socket stand-in for installRefusalRetry: `refuse()` plays a handshake the api turned
// down (socket.io then leaves `active` false), `drop()` a lost transport socket.io retries
// by itself (`active` stays true).
function fakeRetrySocket() {
  const listeners: Record<string, () => void> = {};
  const s = {
    active: true,
    connected: false,
    connect: vi.fn(() => {
      s.active = true;
    }),
    on(event: 'connect' | 'connect_error', cb: () => void) {
      listeners[event] = cb;
    },
    refuse() {
      s.active = false;
      listeners.connect_error?.();
    },
    drop() {
      listeners.connect_error?.();
    },
    accept() {
      s.connected = true;
      listeners.connect?.();
    },
  };
  return s;
}

describe('installRefusalRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after a refused handshake, backing off while the api keeps refusing', () => {
    vi.useFakeTimers();
    const socket = fakeRetrySocket();
    installRefusalRetry(socket as RetrySocket, { minMs: 1_000, maxMs: 4_000 });

    socket.refuse();
    vi.advanceTimersByTime(999);
    expect(socket.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);

    socket.refuse();
    vi.advanceTimersByTime(1_999);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(socket.connect).toHaveBeenCalledTimes(2);

    // Accepted at last: the next refusal starts from the shortest wait again.
    socket.accept();
    socket.connected = false;
    socket.refuse();
    vi.advanceTimersByTime(1_000);
    expect(socket.connect).toHaveBeenCalledTimes(3);
  });

  it("leaves a dropped transport to socket.io's own reconnect", () => {
    vi.useFakeTimers();
    const socket = fakeRetrySocket();
    installRefusalRetry(socket as RetrySocket);

    socket.drop();
    vi.advanceTimersByTime(60_000);

    expect(socket.connect).not.toHaveBeenCalled();
  });
});
