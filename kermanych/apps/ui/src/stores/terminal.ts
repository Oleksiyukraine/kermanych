// apps/ui/src/stores/terminal.ts
// The integrated terminal (docs/specs/2026-09-29-project-terminal.md): panel visibility and
// the machine's running shells, over the api's `/terminal` socket.io namespace. The shells
// live in the api — this store only mirrors the list and routes bytes between a shell and
// the one xterm view attached to it (KTerminalView).
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { TerminalAttachReply, TerminalErrorCode, TerminalInfo, TerminalOpenReply } from '@kermanych/core';
import { getAuthToken } from '../lib/api';
import { SOCKET_ORIGIN, installRefusalRetry, installVisibilityResync } from '../lib/socket';
import { globalTr } from '../boot/i18n';
import { useOrchestrator } from './orchestrator';
import { panelTerminals } from '../lib/native-session';

// What an attached view hands the store: `reset` repaints from the replay (on attach, and
// again after a reconnect, whose room join replays the same history), `data` is the stream.
export type TerminalSink = { reset(replay: string): void; data(chunk: string): void };

const VISIBLE_KEY = 'kermanych.terminal.visible';
const ACK_MS = 10_000;
// The least time between two cycles of the socket for an unanswered attach: an api that is
// itself stuck gets one reconnect per window, not one per timed-out view.
const CYCLE_MIN_MS = 30_000;

export const useTerminal = defineStore('terminal', () => {
  const orchestrator = useOrchestrator();

  const panelVisible = ref(localStorage.getItem(VISIBLE_KEY) === '1');
  // Every shell running on this machine, all projects; the panel filters by the selection.
  const terminals = ref<TerminalInfo[]>([]);
  // False until the first `list` answers: before that «no terminals» is unknown, not true,
  // and the panel must not start a shell on the strength of an empty initial array.
  const loaded = ref(false);
  // The last `list` ack failed (timeout, api down). The panel then stops its skeleton and
  // offers the empty text plus the spawn link — the operator can still start a shell — while
  // `loaded` stays false, so nothing spawns on its own on the strength of an unknown list.
  const listFailed = ref(false);
  const activeByProject = ref<Record<string, string>>({});
  // Projects with a spawn in flight. The panel's «+», its «Новий термінал» link and the
  // footer toggle all start shells; one guard here means none of them can start a second
  // while the first is still being acked, and the panel draws a pending tab for it.
  const opening = ref<Record<string, true>>({});

  let socket: Socket | undefined;
  const sinks = new Map<string, TerminalSink>();
  // Output streamed while an attach is in flight. The api joins this socket to the stream
  // at the very point its replay ends, so these chunks follow the replay — yet they can
  // arrive before the attach's reply does.
  const early = new Map<string, string[]>();
  let lastCycle = -Infinity;

  function setPanel(visible: boolean): void {
    panelVisible.value = visible;
    localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
  }

  function notifyError(code: TerminalErrorCode | 'unreachable', detail?: string): void {
    const text = globalTr.t(`terminal.errors.${code}`);
    orchestrator.notify(detail && code === 'spawn_failed' ? `${text}: ${detail}` : text, 'error', 6000);
  }

  function add(t: TerminalInfo): void {
    if (!terminals.value.some((x) => x.id === t.id)) terminals.value = [...terminals.value, t];
  }

  function remove(id: string): void {
    const gone = terminals.value.find((t) => t.id === id);
    if (!gone) return;
    terminals.value = terminals.value.filter((t) => t.id !== id);
    sinks.delete(id);
    // A native session's pty lives in its Лог tab, not the panel: the panel stays as it is.
    if (gone.sessionId) return;
    const siblings = projectTerminals(gone.projectId);
    if (activeByProject.value[gone.projectId] === id) {
      const next = { ...activeByProject.value };
      if (siblings.length) next[gone.projectId] = siblings[siblings.length - 1]!.id;
      else delete next[gone.projectId];
      activeByProject.value = next;
    }
    // As in VS Code: the last terminal of the project on screen closing hides the panel.
    if (!siblings.length && gone.projectId === orchestrator.selectedProjectId) setPanel(false);
  }

  async function sync(s: Socket): Promise<void> {
    const list = (await s.timeout(ACK_MS).emitWithAck('list')) as TerminalInfo[];
    terminals.value = list;
    loaded.value = true;
    listFailed.value = false;
    // A view whose shell is gone from the list unmounts with its tab; the rest re-attach.
    for (const id of sinks.keys()) {
      // A timed-out re-attach has already cycled the socket (join); the next connect retries.
      if (list.some((t) => t.id === id)) void join(s, id).catch(() => undefined);
    }
  }

  async function join(s: Socket, id: string): Promise<void> {
    const held: string[] = [];
    early.set(id, held);
    try {
      const reply = (await s.timeout(ACK_MS).emitWithAck('attach', { id })) as TerminalAttachReply;
      // A later attach of the same terminal (a reconnect mid-attach) supersedes this one.
      if (early.get(id) !== held) return;
      if ('error' in reply) return remove(id);
      const sink = sinks.get(id);
      sink?.reset(reply.replay);
      for (const chunk of held) sink?.data(chunk);
    } catch (err) {
      // No answer on a socket that thinks it is connected: the transport most likely died
      // under it (a sleep) and socket.io has not noticed yet. Cycle it rather than leave the
      // view on its skeleton — the reconnect's sync() attaches every view again.
      if (early.get(id) === held && sinks.has(id)) cycle(s);
      throw err;
    } finally {
      if (early.get(id) === held) early.delete(id);
    }
  }

  function cycle(s: Socket): void {
    const now = Date.now();
    if (!s.connected || now - lastCycle < CYCLE_MIN_MS) return;
    lastCycle = now;
    s.disconnect();
    s.connect();
  }

  // Idempotent. The handshake reads the token on every attempt, so a token refreshed since
  // the last connect is the one presented.
  function connect(): Socket {
    if (socket) {
      if (!socket.connected && !socket.active) socket.connect();
      return socket;
    }
    const s = io(`${SOCKET_ORIGIN}/terminal`, {
      // Its own connection, not a namespace multiplexed on the events socket's (lib/socket.ts).
      // socket.io closes a shared connection only once every socket on it is down, so while
      // this one was up, the events socket's cycle after a sleep reused the dead transport,
      // and both waited out the ping timeout with keystrokes and re-attaches going nowhere.
      forceNew: true,
      auth: (cb) => cb({ token: getAuthToken() }),
    });
    // The events socket's two recoveries: a handshake the api refused (a token handed over
    // late) is retried, and a long hide (a sleep) cycles the transport that may have died.
    installRefusalRetry(s);
    if (typeof document !== 'undefined') installVisibilityResync(s, document);
    // Every (re)connect, not just the first: an api restart ends every shell, and a plain
    // reconnect drops this socket's room memberships, so both the list and the attached
    // views are re-established from the server.
    s.on('connect', () =>
      void sync(s).catch(() => {
        listFailed.value = true;
        notifyError('unreachable');
      }),
    );
    s.on('opened', (t: TerminalInfo) => add(t));
    s.on('exit', (m: { id: string }) => remove(m.id));
    s.on('data', (m: { id: string; data: string }) => {
      const held = early.get(m.id);
      if (held) held.push(m.data);
      else sinks.get(m.id)?.data(m.data);
    });
    socket = s;
    return s;
  }

  function projectTerminals(projectId: string | undefined): TerminalInfo[] {
    return panelTerminals(terminals.value, projectId);
  }

  function activeFor(projectId: string | undefined): string | undefined {
    if (!projectId) return undefined;
    const id = activeByProject.value[projectId];
    const mine = projectTerminals(projectId);
    return mine.some((t) => t.id === id) ? id : mine[mine.length - 1]?.id;
  }

  function setActive(projectId: string, id: string): void {
    activeByProject.value = { ...activeByProject.value, [projectId]: id };
  }

  // Start a shell in the project's checkout. Size is a first guess; the view fits it on mount.
  async function open(projectId: string, cols = 80, rows = 24): Promise<TerminalInfo | undefined> {
    if (opening.value[projectId]) return undefined;
    opening.value = { ...opening.value, [projectId]: true };
    try {
      const s = connect();
      let reply: TerminalOpenReply;
      try {
        reply = (await s.timeout(ACK_MS).emitWithAck('open', { projectId, cols, rows })) as TerminalOpenReply;
      } catch {
        notifyError('unreachable');
        return undefined;
      }
      if ('error' in reply) {
        notifyError(reply.error, reply.message);
        return undefined;
      }
      add(reply.terminal);
      setActive(projectId, reply.terminal.id);
      return reply.terminal;
    } finally {
      const rest = { ...opening.value };
      delete rest[projectId];
      opening.value = rest;
    }
  }

  function attach(id: string, sink: TerminalSink): void {
    sinks.set(id, sink);
    const s = connect();
    if (s.connected) void join(s, id).catch(() => notifyError('unreachable'));
    // Not connected yet: the `connect` handler's sync() attaches every registered sink.
  }

  function detach(id: string): void {
    if (!sinks.delete(id)) return;
    socket?.emit('detach', { id });
  }

  function input(id: string, data: string): void {
    socket?.emit('input', { id, data });
  }

  function resize(id: string, cols: number, rows: number): void {
    socket?.emit('resize', { id, cols, rows });
  }

  function kill(id: string): void {
    socket?.emit('kill', { id });
  }

  return {
    panelVisible,
    terminals,
    loaded,
    listFailed,
    activeByProject,
    setPanel,
    connect,
    projectTerminals,
    activeFor,
    setActive,
    open,
    opening,
    attach,
    detach,
    input,
    resize,
    kill,
  };
});
