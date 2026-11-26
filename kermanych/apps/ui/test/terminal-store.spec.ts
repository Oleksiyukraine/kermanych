// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTerminal, type TerminalSink } from '../src/stores/terminal';

// The `/terminal` socket carries every keystroke to a shell and every byte back. What an
// operator notices when it breaks: a native agent's Лог that takes no typing, and a switch to
// another agent that stays on the skeleton until the page is reloaded.

type Handler = (...args: unknown[]) => void;

// A socket.io client socket stand-in: `fire` plays the server, `attachReply` answers (or, left
// undefined, never answers) the `attach` ack.
function fakeSocket() {
  const handlers = new Map<string, Handler[]>();
  const s = {
    connected: false,
    active: true,
    disconnected: true,
    attachReply: undefined as unknown,
    emitted: [] as [string, unknown][],
    on(event: string, cb: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return s;
    },
    fire(event: string, ...args: unknown[]) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    emit(event: string, body: unknown) {
      s.emitted.push([event, body]);
      return s;
    },
    timeout(ms: number) {
      return {
        emitWithAck: (event: string, body: unknown) => {
          s.emitted.push([event, body]);
          if (event === 'list') return Promise.resolve([{ id: 't1', projectId: 'p1', sessionId: 's1' }]);
          if (event === 'attach' && s.attachReply !== undefined) return Promise.resolve(s.attachReply);
          return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('operation has timed out')), ms));
        },
      };
    },
    connect: vi.fn(() => {
      s.active = true;
      return s;
    }),
    disconnect: vi.fn(() => {
      s.connected = false;
      s.disconnected = true;
      s.active = false;
      return s;
    }),
    // The server admitted the handshake.
    up() {
      s.connected = true;
      s.disconnected = false;
      s.active = true;
      s.fire('connect');
    },
  };
  return s;
}

let sock: ReturnType<typeof fakeSocket>;
const io = vi.fn((_url: string, _opts?: unknown) => sock);
vi.mock('socket.io-client', () => ({ io: (url: string, opts?: unknown) => io(url, opts) }));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ notify: vi.fn(), selectedProjectId: 'p1' }) }));
vi.mock('../src/boot/i18n', () => ({ globalTr: { t: (k: string) => k, te: () => false } }));
vi.mock('../src/lib/api', () => ({ getAuthToken: () => 'tok' }));

function sink(): TerminalSink & { reset: ReturnType<typeof vi.fn>; data: ReturnType<typeof vi.fn> } {
  return { reset: vi.fn(), data: vi.fn() };
}

function setVisibility(v: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('terminal store — the /terminal socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    sock = fakeSocket();
    io.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens its own connection, so cycling the events socket after a sleep really replaces that transport', () => {
    useTerminal().connect();
    expect(io).toHaveBeenCalledWith(expect.stringMatching(/\/terminal$/), expect.objectContaining({ forceNew: true }));
  });

  it('cycles itself when the window returns from a long hide, and the reconnect repaints every attached view', async () => {
    const store = useTerminal();
    store.connect();
    sock.attachReply = { terminal: { id: 't1' }, replay: 'screen-1' };
    sock.up();
    const view = sink();
    store.attach('t1', view);
    await vi.waitFor(() => expect(view.reset).toHaveBeenCalledWith('screen-1'));

    setVisibility('hidden');
    vi.advanceTimersByTime(60_000); // a laptop sleep
    setVisibility('visible');

    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connect).toHaveBeenCalledTimes(1);

    sock.attachReply = { terminal: { id: 't1' }, replay: 'screen-2' };
    sock.up();
    await vi.waitFor(() => expect(view.reset).toHaveBeenLastCalledWith('screen-2'));
  });

  it('retries a handshake the api refused instead of staying down until a reload', () => {
    const store = useTerminal();
    store.connect();
    sock.active = false; // socket.io never retries a refused handshake on its own
    sock.fire('connect_error', new Error('unauthorized'));
    vi.advanceTimersByTime(1_000);
    expect(sock.connect).toHaveBeenCalled();
  });

  it('cycles a "connected" socket whose attach goes unanswered, so the view leaves its skeleton on the reconnect', async () => {
    const store = useTerminal();
    store.connect();
    sock.up();
    const view = sink();
    store.attach('t1', view); // the transport died silently: no reply ever comes
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sock.disconnect).toHaveBeenCalledTimes(1);
    expect(sock.connect).toHaveBeenCalledTimes(1);
    expect(view.reset).not.toHaveBeenCalled();

    sock.attachReply = { terminal: { id: 't1' }, replay: 'screen' };
    sock.up();
    await vi.waitFor(() => expect(view.reset).toHaveBeenCalledWith('screen'));
  });

  it('does not cycle in a loop while the api itself stays unresponsive', async () => {
    const store = useTerminal();
    store.connect();
    sock.up();
    store.attach('t1', sink());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sock.disconnect).toHaveBeenCalledTimes(1);

    // The reconnect's re-attach times out as well, inside the back-off window.
    sock.up();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sock.disconnect).toHaveBeenCalledTimes(1);
  });
});
