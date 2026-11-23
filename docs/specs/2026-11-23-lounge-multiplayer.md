# «Кімната відпочинку»: playing with colleagues online

- **Date:** 2026-11-23
- **Branch:** `feature/add-lounge-multiplayer-games`
- **Builds on:** `docs/specs/2026-11-18-nail-hammer-minigame.md`,
  `docs/specs/2026-11-19-nail-game-ai-opponents.md`
- **Scope:** `supabase/migrations` (Realtime authorization policies), `packages/cloud`
  (`lounge.ts`), `apps/ui` (a net protocol module, the engine's fixed field, the store, the
  overlay, the header button, i18n `uk` / `en`), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-19: «зробити можливість грати в ігри в кімнаті
  відпочинку онлайн з колегами». The proposal below was accepted on 2026-11-23 («Ніби ок»), with
  the recommended answer on every open point.

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
     `strike {nailId}` or `miss`. The host applies them in the order they arrive: a strike on a
     nail that is gone or already driven counts as a miss. So the first blow to reach the host
     wins a contested nail.
   - The host broadcasts what changed (`spawn`, `hit`, `drive`, `escape`) in one batch every
     50 ms, only when something did, and a full snapshot every 500 ms; a guest that lost a batch
     or rejoined converges on the next snapshot.
   - A guest's hammer swings and knocks at once; the nail sinks when the host's batch arrives
     (~110 ms on the measured link).
3. **A fixed field for multiplayer.** A room's board is 1280 × 720 logical px, scaled to fit each
   window and centred; pointer positions are mapped into it. A solo round keeps the window's size.
4. **Colleagues' hammers** appear where their blows land (the `hit` / `miss` event carries x, y)
   with their name tag, as the AI's hammer does. Pointer positions are not streamed.
5. **Lobby.** The start screen gets «Колеги онлайн» for the workspace in the sidebar's scope:
   who has the lounge open, «Створити кімнату», and «Приєднатися» on each waiting room with its
   host and player count. Each player in a room shows their ping. With no workspace selected it
   says to pick one. The header's «Кімната відпочинку» button carries a dot while a room in that
   workspace waits for players. No other notifications.
6. **Room rules.**
   - At most 6 players, the host included (`LOUNGE_MAX_PLAYERS`).
   - Players join only while the room waits; the host presses «Почати» and everyone gets the
     same 3-2-1 countdown.
   - A presence key is per window, not per account: the same account in two windows is two
     players (and makes a check with one account possible).
   - A guest who leaves keeps their score on the board, marked «вийшов».
   - The host's window hidden: the round pauses for everyone with a banner, and resumes with it.
   - The host leaves: the round is cancelled for everyone («Хост вийшов — раунд скасовано»). No
     host migration in this version.
7. **No AI opponents in a room.** The picker is hidden there. Rejected for now: the host's AI on
   the host's plan.
8. **Not on the leaderboard.** A room's host could forge the result, and a score shared with
   colleagues is not comparable with a solo one; the result screen says so, as it does for AI
   rounds. Within a workspace, a member can also forge broadcasts (a fake `strike`, a fake
   host); nothing is stored, so that is accepted.
9. **«Ігри», not only «Гвіздки».** Every lobby room and message carries `game: 'nails'`, so the
   next game uses the same lobby and channels. No game registry is built ahead of a second game.

## Changes

- **migration `20261123090000_lounge_realtime.sql`:** `public.lounge_topic_workspace(text)` →
  `uuid` (null when the topic is not `lounge:<uuid>` or `lounge:<uuid>:room:<id>`); `select` and
  `insert` policies on `realtime.messages` for `authenticated`. Only adds; nothing older reads it.
- **cloud, `lounge.ts`:** `joinLobby(client, workspaceId, me, handlers)` (presence of windows and
  waiting rooms; `track(room | null)`, `leave()`), `joinRoom(client, workspaceId, roomId, me,
  handlers)` (`send`, presence, `leave()`), both `private: true`, presence keyed per window,
  channel state reported like `subscribeTasks`.
- **ui:**
  - `lib/nail-game-net.ts` (new, pure): the message types, the host's intake of guests' strikes,
    the event batches and snapshots, the guest's mirror (`applyBatch`, `applySnapshot`).
  - `lib/nail-game.ts`: the room's fixed field; nothing else in the rules changes.
  - `stores/lounge.ts` (new): the lobby and the current room for the selected workspace.
  - `NailGameOverlay.vue`: the lobby block, the room's waiting screen, host / guest play, the
    scaled board, pause and cancel banners, the result without the leaderboard; `MainLayout.vue`:
    the header dot.
  - i18n `nailGame.lounge.*` in `uk` / `en`.
- **README:** «Break game («Кімната відпочинку»)» gets «Playing with colleagues»; the migration
  is listed under «Applying a migration to the team's project».

## Verification plan

- `@kermanych/ui` (`vitest run --maxWorkers=4`): `test/nail-game-net.spec.ts` — a guest's mirror
  equals the host's round after a stream of batches, and after a lost batch once the next snapshot
  lands; a strike on a driven nail counts as a miss; points go to the finishing blow across
  players; a host pause stops the guest's clock; a leaving guest keeps their score.
  `vue-tsc --noEmit`, `test/i18n-completeness.spec.ts`.
- `@kermanych/cloud` against a local stack (`supabase start`, the three `SUPABASE_TEST_*`
  variables): a member joins the lobby and a room, sees presence and receives broadcasts; a
  non-member's private join fails; a malformed topic grants nothing; a public channel with the
  same topic receives nothing.
- **A scripted room** on the local stack: a host and two guests (the real `nail-game-net` and
  `lounge.ts`) play one round; the guests' mirrors end equal to the host's tally. The script
  counts the messages sent per second.
- **Live, on screen:** needs the migration pushed to the team's project and a second window
  (the operator's own browser on the preview URL, any account in the same workspace).
- **Assumption to measure:** the project's Realtime message quota. Estimate for 6 players: the
  host ≤ 22 messages/s, each guest ≤ ~5 swings/s, ≈ 47 sends/s, each delivered to 6 windows. The
  scripted room gives the real count; it is compared with the plan's limit in the Supabase
  dashboard before shipping.

## Documentation impact

`kermanych/README.md`: «Break game («Кімната відпочинку»)» — playing with colleagues (who can,
the lobby, the host's role, pause / cancel, not saved); the migration note under «Applying a
migration to the team's project».
