# Міні-гра «Гвіздки»

- **Date:** 2026-11-18
- **Branch:** `feature/add-nail-hammer-minigame`
- **Scope:** `supabase/migrations` (a table, a trigger, a leaderboard function), `packages/cloud`
  (`nail-game.ts`), `apps/ui` (the round engine, a store, the overlay, the header button, i18n
  `uk` / `en`), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-18: «На екрані… зʼявлялись гвіздки (прикольні такі з
  оченятами, іноді покручені). А у гравця курсор перетворювався на молоток… задача за 60 сек
  нагепати якомога більше гвіздків… Щоб користувачі як швидкий короткий відпочинок могли трохи
  розслабитись. Ну і звісно з лідербоардом».

## Goal

A one-minute break inside Kermanych, after the Windows 95 game the operator remembers: nails with
eyes pop up right over the app, some of them bent, the cursor becomes a hammer, and the player
drives in as many nails as they can in 60 seconds. The best results land on a leaderboard, so
colleagues can compete.

## Context

- **Every user is signed in to the team's Supabase project** (README «Start here»); the UI writes
  to the cloud directly through `packages/cloud` on the user's client, and RLS is the only
  authorization surface. `profiles` is readable by any signed-in user (`profiles_select using
  (true)`), so a name and an avatar on a leaderboard expose nothing new.
- **Scopes.** Membership is per workspace (`workspace_members`, `is_workspace_member`). The
  sidebar's scope is `orchestrator.selectedWorkspaceId`.
- **Precedent.** «Надіслати відгук» (`docs/specs/2026-11-13-feedback-form.md`) is the closest
  shape: a header icon beside the gear, one component mounted in `MainLayout`, a store with
  `open`, an insert-only table guarded by a `before insert` trigger.

## Decisions

1. **Rules of a round.**
   - 60 seconds of play after a 3-2-1 countdown. The clock advances by frame time clamped to
     100 ms per frame, so a hidden window pauses the round instead of letting every nail expire.
   - A **straight** nail takes 2 hits and scores 1. A **bent** nail (1 in 4) takes 3 hits, straightens
     as it goes in, and scores 2.
   - A nail lives 2.6 s at the start and 1.7 s at the end; every hit gives it 0.6 s more, so a
     nail being hammered does not vanish under the hammer. An escaped nail costs nothing.
   - Up to 3 nails at once at the start and 7 at the end; a new one every 0.8 s at the start and
     0.38 s at the end. Nails do not overlap and stay clear of the score bar.
   - Misses cost nothing; the result shows the accuracy (hits ÷ swings).
   - The engine is a pure module (`apps/ui/src/lib/nail-game.ts`) with an injected random source,
     so its numbers are tested without a DOM.
2. **It plays over the app, not in a modal.** A full-window transparent layer: the Kermanych
   screen is the «desktop». The system cursor is hidden and a drawn hammer follows the pointer
   and swings on every press. The nails' pupils follow the hammer; a driven nail squints and
   fades with «+1» / «+2». Esc leaves at any time; a round left early is not saved.
3. **Sound** is a short synthesised knock (Web Audio, no files), with a mute toggle remembered on
   this device (`localStorage`, `kermanych.nail-game.muted`).
4. **A score is a row in the team's cloud: `public.nail_game_scores`.** A user may only insert,
   and only as themselves. A `before insert` trigger stamps `created_at` and refuses a second
   score within 50 seconds (`nail_game_too_soon`); a real round takes 63. The score is checked
   against 0…400: perfect play cannot exceed what the engine spawns (a test proves the bound).
   A score of 0 is not sent.
   - Rejected: a server-side game. A client game can always be forged; the bounds and the rate
     limit keep a forged score within what a perfect human could reach, which is enough for a
     break game.
5. **The leaderboard is one function, `nail_game_leaderboard(p_workspace, p_limit)`**
   (`security definer`): each player's best score (ties: who got there first), the top
   `p_limit` (at most 50) plus the caller's own row when it is outside, with the place and the
   number of players. `p_workspace = null` ranks everyone; a workspace id ranks only its
   members, and returns nothing to a caller outside it. Nobody reads the table directly.
6. **Two scopes in the UI:** «Усі» and the workspace in the sidebar's scope (hidden when none is
   selected). The start screen and the result screen show the top 10. The result screen also
   says whether the score is a new personal best and the player's place.
7. **Entry point:** a hammer icon in the header, left of «Надіслати відгук». Nothing else: the
   game is a break, not a feature anyone has to find twice.
8. **Async states.** The leaderboard renders `KSkeleton` through `useLoadPhase` until the reply
   for the current scope arrives; «Ще ніхто не грав» shows only after it. A late reply for the
   other scope is dropped. Saving the score spins on the result screen, and a failure to save
   shows inside it with «Зберегти ще раз». A leaderboard that fails to load does not fail the
   save: the score goes in, the place stays unknown, no record is claimed, and the leaderboard
   shows its own error with «Повторити».

## Changes

- **migration `20261118090000_nail_game.sql`:** the table `nail_game_scores` (insert-only RLS,
  `insert` to `authenticated`), the trigger `nail_game_scores_guard()` (rate limit, stamped
  `created_at`, an advisory lock per user against two parallel inserts) and the function
  `nail_game_leaderboard(uuid, int)` for `authenticated` only.
- **cloud, `nail-game.ts`:** `submitNailGameScore(client, score)`, `nailGameLeaderboard(client,
  { workspaceId, limit })`, `NailGameTooSoonError`, `NAIL_GAME_MAX_SCORE`, type
  `NailGameLeaderRow`.
- **ui:**
  - `lib/nail-game.ts`: the round engine (`createRound`, `advance`, `hitNail`, `swingMiss`,
    the tuning constants).
  - `stores/nail-game.ts`: `open`, the scope, the leaderboard per scope, `submit()`.
  - `components/nail-game/NailGameOverlay.vue` (the layer, the loop, the hammer, the HUD, the
    start and result panels), `NailSprite.vue` (one nail), `NailLeaderboard.vue`.
  - `KIcon` gets `hammer`; `MainLayout.vue` gets the header button and mounts the overlay.
  - i18n: `nailGame.*` in `uk` / `en`.
- **README:** a «Break game («Гвіздки»)» section and the migration under «Applying a migration to
  the team's project».

## Verification

Run on 2026-11-18:

- `@kermanych/cloud`: 292 tests against a local stack (`supabase start`, `supabase migration up`
  with the new migration, the three `SUPABASE_TEST_*` variables set). `test/nail-game.spec.ts`
  (3, new): the too-soon refusal becomes `NailGameTooSoonError`; an out-of-range score is refused
  before it is sent; the leaderboard call and its row mapping. `test/rls.spec.ts` «nail game»
  (3, new): a workspace's leaderboard ranks only its members, best first, keeps the caller's
  own row outside `limit`, and is empty for an outsider; the global one has the outsider's
  score; a second score within 50 s is refused, also back-dated; the table is unreadable to the
  player, a forged `user_id` and an anonymous insert get `42501`, a score of 401 gets `23514`,
  and an anonymous leaderboard call gets `42501`.
- `@kermanych/ui`: 1083 tests before the last store change, then the two new files again (11).
  `test/nail-game.spec.ts` (6, new): hits and points per kind, escape and the hit bonus, the
  frame clamp, the end of the round, the starting cap of 3, and perfect play within
  `NAIL_GAME_MAX_SCORE` (at most 106 spawn ticks × 2 = 212). `test/nail-game-store.spec.ts` (5, new):
  record and place from the scope on screen, no record below the best, nothing sent for 0 and
  the worded too-soon refusal, a save that goes through while the leaderboard is down, and a late
  reply for the other scope. `test/i18n-completeness.spec.ts` passes. `vue-tsc --noEmit` is
  clean.
- **Live preview:** the hammer icon sits left of «Надіслати відгук» and opens the start screen.
  «Почати» counts 3-2-1 with the hammer following the pointer; nails pop up with eyes, a bent one
  leans and is rusty; a hit sinks a nail by half and the hammer lands flat on it. A scripted
  player (pointerdown on the nails every 110 ms for the last ~45 s) finished at 25 points,
  22 nails, 98 % accuracy, and the result screen showed them. The preview's cloud is the hosted
  project without this migration, so the leaderboard and the save both showed their in-place
  errors («Повторити», «Зберегти ще раз»); that was before the save stopped depending on the
  leaderboard. Esc closed the layer after a reload.
- Not verified:
  - a save and a leaderboard against the team's project: the migration is not pushed yet;
  - on screen: a filled leaderboard, «Новий рекорд!», the place line, the scope toggle (covered
    by the store and RLS tests only);
  - the sound (muted in the preview), the `en` texts and the light theme;
  - the desktop build: the preview is the web build;
  - on screen after the last two changes: the result screen without the nails left standing
    (not covered by a test), and the save error alone now that the leaderboard no longer fails
    it (covered by the store test).

## Documentation impact

`kermanych/README.md`: a «Break game («Гвіздки»)» section (rules, what is stored, the leaderboard
and the score bounds) and the migration note under «Applying a migration to the team's project».
