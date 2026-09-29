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
import { SOCKET_ORIGIN } from '../lib/socket';
import { globalTr } from '../boot/i18n';
import { useOrchestrator } from './orchestrator';

// What an attached view hands the store: `reset` repaints from the replay (on attach, and
// again after a reconnect, whose room join replays the same history), `data` is the stream.
export type TerminalSink = { reset(replay: string): void; data(chunk: string): void };

const VISIBLE_KEY = 'kermanych.terminal.visible';
const ACK_MS = 10_000;

export const useTerminal = defineStore('terminal', () => {
  const orchestrator = useOrchestrator();

  const panelVisible = ref(localStorage.getItem(VISIBLE_KEY) === '1');
  // Every shell running on this machine, all projects; the panel filters by the selection.
  const terminals = ref<TerminalInfo[]>([]);
  // False until the first `list` answers: before that «no terminals» is unknown, not true,
  // and the panel must not start a shell on the strength of an empty initial array.
  const loaded = ref(false);
  const activeByProject = ref<Record<string, string>>({});

  let socket: Socket | undefined;
  const sinks = new Map<string, TerminalSink>();

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
    const siblings = terminals.value.filter((t) => t.projectId === gone.projectId);
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
    // A view whose shell is gone from the list unmounts with its tab; the rest re-attach.
    for (const id of sinks.keys()) {
      if (list.some((t) => t.id === id)) void join(s, id);
    }
  }

  async function join(s: Socket, id: string): Promise<void> {
    const reply = (await s.timeout(ACK_MS).emitWithAck('attach', { id })) as TerminalAttachReply;
    if ('error' in reply) return remove(id);
    sinks.get(id)?.reset(reply.replay);
  }

  // Idempotent. The handshake reads the token on every attempt, so a token refreshed since
  // the last connect is the one presented. A refused handshake is not retried by socket.io;
  // the next call revives it.
  function connect(): Socket {
    if (socket) {
      if (!socket.connected && !socket.active) socket.connect();
      return socket;
    }
    const s = io(`${SOCKET_ORIGIN}/terminal`, {
      auth: (cb) => cb({ token: getAuthToken() }),
    });
    // Every (re)connect, not just the first: an api restart ends every shell, and a plain
    // reconnect drops this socket's room memberships, so both the list and the attached
    // views are re-established from the server.
    s.on('connect', () => void sync(s).catch(() => notifyError('unreachable')));
    s.on('opened', (t: TerminalInfo) => add(t));
    s.on('exit', (m: { id: string }) => remove(m.id));
    s.on('data', (m: { id: string; data: string }) => sinks.get(m.id)?.data(m.data));
    socket = s;
    return s;
  }

  function projectTerminals(projectId: string | undefined): TerminalInfo[] {
    return projectId ? terminals.value.filter((t) => t.projectId === projectId) : [];
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
    activeByProject,
    setPanel,
    connect,
    projectTerminals,
    activeFor,
    setActive,
    open,
    attach,
    detach,
    input,
    resize,
    kill,
  };
});
