// «Кімната відпочинку» with colleagues (docs/specs/2026-11-23-lounge-multiplayer.md): the lobby
// and the rooms on Supabase Realtime. Both are PRIVATE channels; the policies on
// `realtime.messages` (supabase/migrations/20261123090000_lounge_realtime.sql) let only the
// members of the workspace in the topic join, hear and send. This module is the transport only:
// what a game sends is the caller's.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/** The four states realtime-js hands to a subscribe() callback. */
export type LoungeChannelState = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/** One window of one signed-in user. A user with two windows open is two entries. */
export type LoungeIdentity = {
  /** Per window, not per account: the presence key. */
  clientId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
};

/** A room waiting for players or playing, as its host announces it in the lobby. */
export type LoungeRoomInfo = {
  id: string;
  game: "nails";
  players: number;
  playing: boolean;
};

/** A window in the lobby; `room` is the room it hosts. */
export type LoungeWindow = LoungeIdentity & { room: LoungeRoomInfo | null };

/** A window in a room. */
export type LoungeMember = LoungeIdentity & {
  host: boolean;
  /** When it joined the room, by its own clock: the host seats players in this order. */
  joinedAt: number;
};

export const loungeTopic = (workspaceId: string): string => `lounge:${workspaceId}`;
export const loungeRoomTopic = (workspaceId: string, roomId: string): string => `lounge:${workspaceId}:room:${roomId}`;

/**
 * Realtime lets a client send 5 presence messages (a track or an untrack) per 30 s on one channel
 * and closes the channel past that (`ClientPresenceRateLimitReached`, measured on the local
 * stack). One every 6 s stays inside it, so presence changes are coalesced to that pace.
 */
export const PRESENCE_MIN_GAP_MS = 6_000;

// presenceState() holds a list of metas per key (one per track() from that key); the last one
// is the window's current state.
function presenceList<T>(channel: RealtimeChannel): T[] {
  const state = channel.presenceState<T & Record<string, unknown>>();
  const out: T[] = [];
  for (const metas of Object.values(state)) {
    const last = metas[metas.length - 1];
    if (last) out.push(last as T);
  }
  return out;
}

type Handlers<P> = {
  onPresence: (present: P[]) => void;
  onState?: (state: LoungeChannelState) => void;
};

// A private channel with per-window presence. present() before SUBSCRIBED waits for it; after,
// it sends at most one presence message per PRESENCE_MIN_GAP_MS, the latest state winning.
function openChannel<P>(client: SupabaseClient, topic: string, clientId: string, handlers: Handlers<P>) {
  const channel = client.channel(topic, {
    config: { private: true, presence: { key: clientId, enabled: true }, broadcast: { self: false } },
  });
  let subscribed = false;
  let pending: Record<string, unknown> | null = null;
  // What the server holds for this window ("null": nothing tracked), and when it was sent.
  let sentKey = "null";
  let sentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush(): void {
    timer = undefined;
    const key = JSON.stringify(pending);
    if (!subscribed || key === sentKey) return;
    const wait = sentAt + PRESENCE_MIN_GAP_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(flush, wait);
      return;
    }
    sentKey = key;
    sentAt = Date.now();
    void (pending ? channel.track(pending) : channel.untrack()).catch(() => undefined);
  }
  channel.on("presence", { event: "sync" }, () => handlers.onPresence(presenceList<P>(channel)));
  return {
    channel,
    subscribe() {
      channel.subscribe((status) => {
        subscribed = status === "SUBSCRIBED";
        handlers.onState?.(status as LoungeChannelState);
        if (subscribed) {
          // A fresh join holds nothing of this window: send its state again.
          sentKey = "null";
          flush();
        }
      });
    },
    /** Be present with `meta`, or not at all with null. */
    present(meta: Record<string, unknown> | null) {
      pending = meta;
      if (!timer) flush();
    },
    leave() {
      clearTimeout(timer);
      void client.removeChannel(channel);
    },
  };
}

export type LoungeLobby = {
  /** Be in the lobby (hosting `room`, or none), or leave its presence with undefined. */
  present(room: LoungeRoomInfo | null | undefined): void;
  leave(): void;
};

/** The workspace's lobby: every window with the lounge open, and the rooms they host. */
export function joinLoungeLobby(
  client: SupabaseClient,
  workspaceId: string,
  me: LoungeIdentity,
  handlers: Handlers<LoungeWindow>,
): LoungeLobby {
  const ch = openChannel<LoungeWindow>(client, loungeTopic(workspaceId), me.clientId, handlers);
  ch.subscribe();
  return {
    present: (room) => ch.present(room === undefined ? null : { ...me, room }),
    leave: ch.leave,
  };
}

export type LoungeRoom = {
  /** Broadcast to everyone else in the room. */
  send(event: string, payload: Record<string, unknown>): void;
  leave(): void;
};

/** One room: its players' presence and the messages of its rounds. */
export function joinLoungeRoom(
  client: SupabaseClient,
  workspaceId: string,
  roomId: string,
  me: LoungeMember,
  handlers: Handlers<LoungeMember> & { onMessage: (event: string, payload: Record<string, unknown>) => void },
): LoungeRoom {
  const ch = openChannel<LoungeMember>(client, loungeRoomTopic(workspaceId, roomId), me.clientId, handlers);
  ch.channel.on("broadcast", { event: "*" }, (msg: { event: string; payload?: Record<string, unknown> }) =>
    handlers.onMessage(msg.event, msg.payload ?? {}),
  );
  // Tracked once, on join: a room's presence is who is in it, nothing that changes.
  ch.present({ ...me });
  ch.subscribe();
  return {
    send(event, payload) {
      void ch.channel.send({ type: "broadcast", event, payload }).catch(() => undefined);
    },
    leave: ch.leave,
  };
}
