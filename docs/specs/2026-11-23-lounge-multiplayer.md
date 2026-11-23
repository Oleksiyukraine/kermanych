# «Кімната відпочинку»: playing with colleagues online

- **Date:** 2026-11-23
- **Branch:** `feature/add-lounge-multiplayer-games`
- **Builds on:** `docs/specs/2026-11-18-nail-hammer-minigame.md`,
  `docs/specs/2026-11-19-nail-game-ai-opponents.md`
- **Scope:** `supabase/migrations` (Realtime authorization policies), `packages/cloud`
  (`lounge.ts`), `apps/ui` (a net protocol module, a store, two components, the overlay, the
  header button, i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-19: «зробити можливість грати в ігри в кімнаті
  відпочинку онлайн з колегами». The proposal below was accepted on 2026-11-23 («Ніби ок»), with
  the recommended answer on every open point; the operator pushes the migration to the team's
  project once the code is ready. Implemented on 2026-11-23.

## Goal

Colleagues from one workspace see who is in «Кімната відпочинку» and play a round of «Гвіздки»
together on one board, each from their own machine.

## Context

- **The api is local.** Every user runs their own `apps/api`; colleagues' machines cannot reach
  each other. The one thing they share is the team's Supabase project, which every signed-in
  window is already connected to (README «The shared board (cloud)»). The app uses Realtime today
  only for `postgres_changes` on public channels (`packages/cloud/src/tasks.ts` and the
  Jira / Linear / Plane / skill-improvement mirrors).
- **The engine already has several players.** `apps/ui/src/lib/nail-game.ts` keeps
  `players: PlayerTally[]`; `hitNail(r, id, who)` gives a nail's points to the finishing blow;
  AI opponents play through it. A colleague is one more player.
- **Two things do not carry over as they are:** the field is the window
  (`window.innerWidth/innerHeight`), and colleagues' windows differ; the clock pauses when the
  window is hidden (`FRAME_CLAMP_MS`), so two clients running their own clocks drift apart.
- **Measured** on 2026-11-19 from this machine against the team's project: a Realtime Broadcast
  round trip between two clients (60 pings, 100 ms apart) took p50 110 ms, p90 119 ms, max
  126 ms — about 55 ms one way, against a nail that lives 1.7–2.6 s. Between colleagues on other
  networks this is not measured; the lobby shows each player's ping (decision 5).
- **Public channels are open to anyone.** The same probe subscribed with only the publishable key
  and no sign-in. Private channels are checked against RLS policies on `realtime.messages`
  (`realtime.topic()`, `extension` = `broadcast` / `presence`). Realtime keeps a private topic
  apart from a public one of the same name (`tenant_topic(…, false)` →
  `"<tenant>-private:<topic>"` in `supabase/realtime` `lib/realtime/tenants.ex`), so the project's
  «Allow public access» setting can stay on — turning it off would break the board's public
  `postgres_changes` channels.
- **Measured while building it** (local stack): Realtime closes a private channel whose client
  sends more than 5 presence messages (a track or an untrack) in 30 s —
  `ClientPresenceRateLimitReached`, the default `client_presence_rate_limit` of
  `max_calls: 5, window_ms: 30_000` in `presence_handler.ex`. A first build that re-tracked each
  guest's ping every 3 s lost its room 15 s in. A refused private join answers `CHANNEL_ERROR`
  after ~5 s, and realtime-js retries it.

## Decisions

1. **Transport: Supabase Realtime, private channels, workspace members only.**
   - `lounge:<workspace_id>` — the lobby. Presence: who has the lounge open, and the rooms
     waiting for players.
   - `lounge:<workspace_id>:room:<room_id>` — one room. Broadcast carries the round; Presence
     tells who is in it.
   - A migration lets `authenticated` read and send (`select` / `insert` on `realtime.messages`,
     extensions `broadcast` and `presence`) when the topic parses to a workspace the caller is a
     member of (`is_workspace_member`). A topic that does not parse grants nothing.
   - No table for rooms: a room exists while its host is present in the lobby.
   - Rejected: `postgres_changes` on a table (every blow a database write, slower and heavier);
     WebRTC peer-to-peer (still needs signalling, and TURN behind corporate NATs, to save ~55 ms);
     a WebSocket on the local api (unreachable between machines); lockstep with a shared seed
     («who drove it in» still needs one judge, and a hidden window desyncs the clocks); everyone
     signed in (sign-in is open to any GitHub account, so strangers could join).
2. **The host's window is the judge.** Whoever creates the room runs the `Round`, as a solo round
   does today.
   - A guest's swing is tested locally against its mirror (`nailAt`) and sent as
     `swing {who, nailId | null, x, y}`. The host applies them in the order they arrive: a strike
     on a nail that is gone or already driven counts as a miss. So the first blow to reach the
     host wins a contested nail.
   - The host broadcasts what changed — every nail whose state moved (spawned, hit, driven,
     escaped) and the blows struck — in one batch every 50 ms, only when something did, and a full
     snapshot every 500 ms; a guest that lost a batch converges on the next snapshot. Every
     message carries a sequence number, and an older one is dropped.
   - A guest's hammer swings and knocks at once; the nail sinks when the host's batch arrives
     (~110 ms on the measured link).
3. **A fixed field for multiplayer.** A room's board is 1280 × 720 logical px, scaled to fit each
   window and centred; pointer positions are mapped into it. A solo round keeps the window's size.
4. **Colleagues' hammers** appear where their blows land (the `hit` / `miss` event carries x, y)
   with their name tag, as the AI's hammer does. Pointer positions are not streamed.
5. **Lobby.** The start screen gets «Колеги онлайн» for the workspace in the sidebar's scope:
   who has the lounge open, «Створити кімнату», and «Приєднатися» on each waiting room with its
   host and player count. Each guest in a room shows their ping to the host: a guest pings every
   3 s and broadcasts the round trip (`ping` / `pong` / `rtt`), not presence (see the measured
   limit above). A window's lobby line changes at most once every 6 s
   (`PRESENCE_MIN_GAP_MS`), the latest state winning. With no workspace selected it says to pick
   one; in a preview, which has no team cloud, it says the lobby works in the app only. The
   header's «Кімната відпочинку» button carries a dot while a room in that workspace waits for
   players. No other notifications.
6. **Room rules.**
   - At most 6 players, the host included (`LOUNGE_MAX_PLAYERS`).
   - Players join only while the room waits; the host presses «Почати» and everyone gets the
     same 3-2-1 countdown.
   - A presence key is per window, not per account: the same account in two windows is two
     players (and makes a check with one account possible).
   - A guest who leaves keeps their score on the board, marked «вийшов».
   - The host's window hidden: the round pauses for everyone with a banner, and resumes with it.
   - The host leaves: the round is cancelled for everyone («Хост вийшов, тож раунд
     скасовано»). No host migration in this version. A room whose channel the server closes ends
     for that window with «Зв’язок із кімнатою обірвався».
7. **No AI opponents in a room.** The picker is hidden there. Rejected for now: the host's AI on
   the host's plan.
8. **Not on the leaderboard.** A room's host could forge the result, and a score shared with
   colleagues is not comparable with a solo one; the result screen says so, as it does for AI
   rounds. Within a workspace, a member can also forge broadcasts (a fake `strike`, a fake
   host); nothing is stored, so that is accepted.
9. **«Ігри», not only «Гвіздки».** A lobby room carries `game: 'nails'`, and the round's messages
   ride the broadcast event `nails`, so the next game uses the same lobby and channels with its
   own event. No game registry is built ahead of a second game.

## Changes

- **migration `20261123090000_lounge_realtime.sql`:** `public.lounge_topic_workspace(text)` →
  `uuid` (null when the topic is not `lounge:<uuid>` or `lounge:<uuid>:room:<id>`); `select` and
  `insert` policies on `realtime.messages` for `authenticated`. Only adds; nothing older uses
  private channels.
- **cloud, `lounge.ts`:** `joinLoungeLobby(client, workspaceId, me, handlers)` (`present(room |
  null | undefined)`, `leave()`), `joinLoungeRoom(client, workspaceId, roomId, me, handlers)`
  (`send`, `leave()`), both `private: true`, presence keyed per window and paced by
  `PRESENCE_MIN_GAP_MS`; `loungeTopic`, `loungeRoomTopic`; types `LoungeIdentity`,
  `LoungeWindow`, `LoungeRoomInfo`, `LoungeMember`, `LoungeChannelState`.
- **ui:**
  - `lib/nail-game-net.ts` (new, pure): `ROOM_FIELD`, `LOUNGE_MAX_PLAYERS`, the message types,
    `createHost` / `hostSwing` / `hostOutgoing` / `hostSnapshot`, `readGuestMsg` /
    `readHostMsg`, the guest's mirror (`createMirror`, `applyHost`, `tickMirror`,
    `hostSilent`). `lib/nail-game.ts` is unchanged: a room passes `ROOM_FIELD` to `createRound`.
  - `stores/lounge.ts` (new): the lobby and the current room for the selected workspace, the
    pings, the host's lobby line.
  - `components/nail-game/LoungeLobby.vue`, `LoungeRoomPanel.vue` (new); `NailGameOverlay.vue`:
    the lobby block, the room's waiting screen, host / guest play, the scaled board, the
    colleagues' hammers, the pause banner, the result without the leaderboard;
    `MainLayout.vue`: the header dot.
  - i18n `nailGame.lounge.*` in `uk` / `en`.
- **README:** «Break game («Кімната відпочинку»)» gets «Playing with colleagues»; the migration
  is listed under «Applying a migration to the team's project».

## Verification

Run on 2026-11-23:

- `@kermanych/ui`: 1112 tests pass (`vitest run --maxWorkers=4`). `test/nail-game-net.spec.ts`
  (6, new): a guest's mirror equals the host's board after every batch of a whole contested
  round and ends on the same tally; a lost batch is mended by the next snapshot within 500 ms; a
  blow on a nail someone else drove in first is a miss and the points go to the finishing blow; a
  paused or silent host stops the guest's clock and an older message is dropped; a guest who
  left keeps their score; the host applies only a well-formed blow from a guest seat.
  `vue-tsc --noEmit` is clean; `test/i18n-completeness.spec.ts` passes.
- `@kermanych/cloud` against a local stack (`supabase start`, the migration applied, the three
  `SUPABASE_TEST_*` variables): `test/rls.spec.ts` 79 pass, «lounge realtime» (4, new) — a
  member sees the lobby and the room its host announces, an outsider's join gets
  `CHANNEL_ERROR`; a room's broadcast reaches its member while an anonymous public channel of
  the same topic hears nothing; a private topic outside the lounge's shape is refused; a burst
  of 8 presence changes keeps the lobby channel open and ends on the latest state. The last one
  fails with `PRESENCE_MIN_GAP_MS = 0`.
- **A scripted room** on the local stack (a throwaway vitest, the real `lounge.ts` and
  `nail-game-net.ts`, three signed-in users): 61 s, both guests' mirrors ended with the host's
  tally; 1439 sends, 23.6 per second on average and 27 at most for 3 players (each guest
  swinging 5 times a second); a guest's clock ran 3 ms behind the host's at p50, 8 ms at p95.
- **On screen** (the ui dev server and a standalone api against the local stack, signed in as
  one user, a scripted colleague as the other): the header button showed the dot for her waiting
  room; «Колеги онлайн» listed her and «Кімната: Марта Колега · гравців: 1 з 6 · чекає на
  гравців»; «Приєднатися» opened the room's screen with her as host. As host, «Ваша кімната»
  showed her ping (2 ms), «Почати раунд» started the countdown on both sides; her hammer with
  its name tag struck on the scaled board and her nails were ringed in her colour; the result
  ranked «Марта Колега 77» over «Ви 25» with «Раунд із колегами не потрапляє до лідерів», the
  same tally her window ended with. As guest, the board followed hers to the end (28 : 16 on
  both sides). When she left, the lounge went back to the start screen with «Хост вийшов, тож
  раунд скасовано» and the dot went out. The first attempt found the presence limit above.
- Not verified:
  - against the team's project: the migration is not pushed yet (the operator pushes it);
  - the pause banner when the host's window is hidden, and a guest leaving mid-round on screen
    (both covered by the protocol tests only);
  - more than 3 players, and the 6-player cap and «Кімната заповнена» on screen;
  - the project's Realtime message quota: measured 23.6 sends/s for 3 players; 6 players should
    reach ~47/s, to compare with the plan's limit in the Supabase dashboard;
  - the desktop build, the light theme and the `en` texts on screen.

## Documentation impact

`kermanych/README.md`: «Break game («Кімната відпочинку»)» — playing with colleagues (who can,
the lobby, the host's role, pause / cancel, not saved, the presence limit); the migration note
under «Applying a migration to the team's project».
