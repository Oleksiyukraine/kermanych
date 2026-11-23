// «Кімната відпочинку» with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md): the lobby of
// the workspace in the sidebar's scope and the room this window is in, over the private Realtime
// channels of packages/cloud lounge.ts. The round itself is the overlay's (lib/nail-game-net.ts);
// this store carries its messages and answers the room's pings.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  joinLoungeLobby,
  joinLoungeRoom,
  type LoungeChannelState,
  type LoungeIdentity,
  type LoungeLobby,
  type LoungeMember,
  type LoungeRoom,
  type LoungeWindow,
} from '@kermanych/cloud';
import { globalTr } from '../boot/i18n';
import { IS_PREVIEW } from '../lib/preview';
import { LOUNGE_MAX_PLAYERS, NAILS_EVENT, type HostMsg, type GuestMsg } from '../lib/nail-game-net';
import { useAuth } from './auth';
import { useNailGame } from './nail-game';
import { useOrchestrator } from './orchestrator';

/** A guest measures its round trip to the host this often. */
const PING_EVERY_MS = 3000;

export type LoungeRoomView = {
  id: string;
  hostClientId: string;
  isHost: boolean;
  /** Everyone in the room, the host first, then by when they came. undefined until the first sync. */
  members: LoungeMember[] | undefined;
  /** The host was in the room and is not any more, or never was: the room is over. */
  hostGone: boolean;
  /** The server closed this window's channel to the room. */
  lost: boolean;
};

/** A room some colleague hosts, as the lobby shows it. */
export type LoungeRoomCard = { id: string; host: LoungeWindow; players: number; playing: boolean };

export const useLounge = defineStore('lounge', () => {
  const auth = useAuth();
  const orch = useOrchestrator();
  const game = useNailGame();

  // Per window: the same account in two windows is two players (decision 6).
  const clientId = crypto.randomUUID();

  const identity = computed<LoungeIdentity | null>(() => {
    const p = auth.profile;
    if (IS_PREVIEW || !auth.user || !p) return null;
    return {
      clientId,
      userId: auth.user.id,
      name: p.displayName ?? p.githubUsername ?? auth.user.email ?? globalTr.t('nailGame.lounge.someone'),
      avatarUrl: p.avatarUrl ?? null,
    };
  });
  /** The workspace whose lounge this window is in; null when it cannot be (no workspace, a preview, signed out). */
  const workspaceId = computed(() => (identity.value ? orch.selectedWorkspaceId : null));

  // undefined = not synced yet for this workspace.
  const windows = ref<LoungeWindow[] | undefined>(undefined);
  const lobbyState = ref<LoungeChannelState | null>(null);
  let lobby: LoungeLobby | null = null;

  const room = ref<LoungeRoomView | null>(null);
  let channel: LoungeRoom | null = null;
  /** Each guest's last round trip to the host, ms, by window: what the room's screen shows. */
  const pings = ref<Record<string, number>>({});
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(msg: Record<string, unknown>) => void>();

  /** Colleagues with the lounge open: each account once, this window's own excluded. */
  const colleagues = computed(() => {
    const seen = new Map<string, LoungeWindow>();
    for (const w of windows.value ?? []) if (w.clientId !== clientId && !seen.has(w.userId)) seen.set(w.userId, w);
    return [...seen.values()];
  });

  const rooms = computed<LoungeRoomCard[]>(() =>
    (windows.value ?? [])
      .filter((w) => w.room && w.clientId !== clientId)
      .map((w) => ({ id: w.room!.id, host: w, players: w.room!.players, playing: w.room!.playing })),
  );

  /** A colleague's room waits for players: the header's button carries a dot. */
  const waiting = computed(() => rooms.value.some((r) => !r.playing && r.players < LOUNGE_MAX_PLAYERS));

  /** The room this window is in is playing a round (by its host's announcement in the lobby). */
  const roomPlaying = ref(false);
  const hostingPlaying = ref(false);
  watch(
    [room, windows],
    () => {
      const r = room.value;
      if (!r || r.isHost) return;
      roomPlaying.value = (windows.value ?? []).find((w) => w.clientId === r.hostClientId)?.room?.playing ?? false;
    },
    { deep: false },
  );

  // This window's line in the lobby: present while the overlay is open, with the room it hosts.
  function syncPresence(): void {
    if (!lobby) return;
    if (!game.open) {
      lobby.present(undefined);
      return;
    }
    const r = room.value;
    lobby.present(
      r?.isHost
        ? { id: r.id, game: 'nails', players: r.members?.length ?? 1, playing: hostingPlaying.value }
        : null,
    );
  }

  watch(
    workspaceId,
    (id) => {
      leaveRoom();
      lobby?.leave();
      lobby = null;
      windows.value = undefined;
      lobbyState.value = null;
      if (!id || !identity.value) return;
      lobby = joinLoungeLobby(auth.client, id, identity.value, {
        onPresence: (present) => (windows.value = present),
        onState: (s) => (lobbyState.value = s),
      });
      syncPresence();
    },
    { immediate: true },
  );
  watch(() => game.open, syncPresence);

  // A guest's round trip to the host. Pings ride broadcast, not presence: Realtime closes a
  // channel whose client tracks presence more than 5 times in 30 s (PRESENCE_MIN_GAP_MS).
  function onMessage(event: string, payload: Record<string, unknown>): void {
    if (event === 'ping' && room.value?.isHost) {
      channel?.send('pong', { to: payload.from, t0: payload.t0 });
      return;
    }
    if (event === 'pong') {
      if (payload.to !== clientId || typeof payload.t0 !== 'number') return;
      const ms = Math.round(performance.now() - payload.t0);
      pings.value = { ...pings.value, [clientId]: ms };
      channel?.send('rtt', { from: clientId, ms });
      return;
    }
    if (event === 'rtt') {
      if (typeof payload.from === 'string' && typeof payload.ms === 'number') {
        pings.value = { ...pings.value, [payload.from]: payload.ms };
      }
      return;
    }
    if (event === NAILS_EVENT) for (const fn of listeners) fn(payload);
  }

  function onRoster(present: LoungeMember[]): void {
    const r = room.value;
    if (!r) return;
    const members = [...present].sort((a, b) => Number(b.host) - Number(a.host) || a.joinedAt - b.joinedAt);
    const hostHere = members.some((m) => m.clientId === r.hostClientId);
    // The first sync is the room's state as the server holds it: a guest who finds no host there
    // came to a room that is already over.
    room.value = { ...r, members, hostGone: r.hostGone || (!r.isHost && !hostHere) };
    if (r.isHost) syncPresence();
  }

  // Resolves once the room's channel is joined; rejects when the server refuses it.
  function enter(roomId: string, hostClientId: string, isHost: boolean): Promise<void> {
    const ws = workspaceId.value;
    const who = identity.value;
    if (!ws || !who) return Promise.reject(new Error(globalTr.t('nailGame.lounge.unavailable')));
    leaveRoom();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const me: LoungeMember = { ...who, host: isHost, joinedAt: Date.now() };
    room.value = { id: roomId, hostClientId, isHost, members: undefined, hostGone: false, lost: false };
    pings.value = {};
    roomPlaying.value = false;
    hostingPlaying.value = false;
    let joined = false;
    const ch = joinLoungeRoom(auth.client, ws, roomId, me, {
      onPresence: onRoster,
      onMessage,
      onState: (s) => {
        if (channel !== ch) return;
        if (s === 'SUBSCRIBED') {
          joined = true;
          resolve();
        } else if (!joined && s !== 'CLOSED') {
          leaveRoom();
          reject(new Error(globalTr.t('nailGame.lounge.joinFailed')));
        } else if (joined && s === 'CLOSED' && room.value) {
          // Not this window's leaving (that drops `channel` first): the server closed it.
          room.value = { ...room.value, lost: true };
        }
      },
    });
    channel = ch;
    if (!isHost) {
      pingTimer = setInterval(() => channel?.send('ping', { from: clientId, t0: performance.now() }), PING_EVERY_MS);
    }
    return promise;
  }

  /** Host a new room: colleagues see it in the lobby and may join while it waits. */
  async function createRoom(): Promise<void> {
    await enter(crypto.randomUUID(), clientId, true);
    syncPresence();
  }

  async function joinRoom(card: LoungeRoomCard): Promise<void> {
    await enter(card.id, card.host.clientId, false);
  }

  /** Leave the room; a host's leaving ends it for everyone. */
  function leaveRoom(): void {
    clearInterval(pingTimer);
    pingTimer = undefined;
    const ch = channel;
    if (!ch) return;
    channel = null;
    if (room.value?.isHost) ch.send(NAILS_EVENT, { t: 'cancel' } satisfies HostMsg);
    ch.leave();
    room.value = null;
    pings.value = {};
    hostingPlaying.value = false;
    syncPresence();
  }

  /** The host announces in the lobby whether a round is on, so nobody tries to join it. */
  function setPlaying(playing: boolean): void {
    hostingPlaying.value = playing;
    syncPresence();
  }

  function send(msg: HostMsg | GuestMsg): void {
    channel?.send(NAILS_EVENT, msg);
  }

  /** Hear the room's game messages; returns the unsubscribe. */
  function onGame(fn: (msg: Record<string, unknown>) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    clientId,
    workspaceId,
    windows,
    lobbyState,
    colleagues,
    rooms,
    waiting,
    room,
    pings,
    roomPlaying,
    createRoom,
    joinRoom,
    leaveRoom,
    setPlaying,
    send,
    onGame,
  };
});
