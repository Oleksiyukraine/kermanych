# «Гвіздки»: hammer, hit area, driven nails, AI opponents and the arena

- **Date:** 2026-11-19
- **Branch:** `feature/add-hammer-game`
- **Builds on:** `docs/specs/2026-11-18-nail-hammer-minigame.md`
- **Scope:** `apps/ui` (the round engine, a new AI seat module, the overlay, the nail sprite, a
  hammer component, the store, i18n `uk` / `en`), `apps/api` (a controller, a service on the chat
  pool, the prompt), `packages/core` (wire types, limits, three error codes), `kermanych/README.md`.
- **Status:** asked by the operator on 2026-11-19 after watching an agent play the game:
  «анімація молотку зараз не правильна, він ніби знизу вгору бʼє… хіпбокс гвіздка зараз дуже
  маленький… після того як гвіздок забивається, треба залишати його на екрані, але вже
  „забитим“… коли я стартую гру, я хочу мати можливість вибрати суперника (ШІ), і вибрати просто,
  з якою моделлю я буду змагатись… також я хочу мати можливість зробити „арену“, коли я і декілька
  моделей змагаються на одній дошці».

## Goal

Three fixes to the game shipped yesterday, and two additions: a duel against one AI model the
player picks, and an arena where the player and several models play on one board.

## Context

- **The hammer** (`NailGameOverlay.vue`) rested at `rotate(-26deg)` and swung to `rotate(2deg)`
  around the end of its handle. The head is left of that pivot, so a negative angle lowered it:
  the rest pose had the head *below* the striking point and every swing lifted it — a blow from
  below. At rest the head was drawn ~25 px away from where the click actually counted.
- **The hit area** was a transparent `<rect>` inside the nail's svg that shrank as the nail sank
  (its top followed the head), so the second and third blows had a smaller target than the first.
- **A driven nail** squinted, faded and left the list 450 ms later (`LINGER_MS`).
- **Models.** Every model call in the api goes through `omp` (`RpcSession`); the chat assistants
  (ЦУК, Менеджмент) keep one warm, tool-less child per conversation on `RpcChatPool`
  (`apps/api/src/assistant/rpc-chat-pool.ts`). `GET /models` lists what this machine's omp has
  credentials for; the UI keeps it in `useOrchestrator().models`.
- **Measured before designing** (this machine, warm child, no tools, `--thinking off`, a board of
  three nails): a turn takes 0.9–1.1 s on Claude Haiku 4.5, 1.6–2.2 s on Claude Opus 5 and
  1.9–2.2 s on Claude Sonnet 5 (one 5.9 s outlier); a child is ready in ~0.6 s. Sonnet and Opus
  picked the nail closest to escaping first; Haiku did not. A nail lives 1.7–2.6 s, so a model
  cannot be asked per strike, but it can plan a few strikes per answer.

## Decisions

1. **The hammer swings down.** At rest it is turned `+34°` about the end of the handle, which
   raises the head up and away from the nail; a swing turns it to `0°`, where the striking face
   (the bottom of the head) lies on the pointer. Down in 45 ms, back up in 140 ms. One component,
   `NailHammer.vue`, draws the player's hammer and every opponent's.
2. **Hits are geometry, not DOM.** `nailAt(round, x, y)` in the engine: a swing lands on a
   standing nail when it is inside the nail's 56 × 96 box grown by `HIT_PAD` = 18 px on every
   side (92 × 132 px), the same size from the first blow to the last. When two areas overlap, the
   nail whose centre is nearer wins. The sprite takes no pointer events. An AI's strike names its
   nail by id and goes straight to `hitNail`.
3. **Driven nails stay.** A driven nail keeps its place, flush with the ground with happy closed
   eyes, a little dimmer than the nails in play, until the round ends; it also stays behind the
   result panel. Only escaped nails leave the list. New nails are placed clear of driven ones while
   there is room, and clear of standing ones in any case, so a full board never stops spawning
   (the spawn rate still bounds the score).
4. **Opponents are real models, playing with the same hands.**
   - Each opponent is a tool-less omp child on the model the player picked, on its own
     `RpcChatPool` key (`nail-game:<user>:<model>`), thinking `off` for every model so the race is
     between the models, not their settings.
   - The overlay asks a seat for a move whenever it has at most one planned strike left and is not
     already waiting: it sends the board (every standing nail: id, kind, strikes left, ms left;
     the seat's last round trip as `lag`; its score and the best other score). The model answers
     with up to 6 nail ids, one per strike. The api keeps the ids that are on that board and drops
     everything else in the text.
   - A seat's hammer plays the plan at a fixed hand speed: one strike every 180 ms
     (`NAIL_GAME_AI_STRIKE_MS`), gliding to the nail's head in the first 110 ms. A strike on a
     nail that is gone or driven by then is skipped without a swing. A new answer replaces what is
     left of the old plan. So a model wins by answering fast and choosing well; its hands are the
     same as every other model's.
   - The contract is sent once per round, with the first board; later turns are the board only.
     `POST /nail-game/ai/warm` replaces each opponent's child with a fresh one before the
     countdown (the start button spins meanwhile); `POST /nail-game/ai/release` stops them when
     the round ends or the player leaves. The pool's idle sweep stops a child whose release was
     lost. A move that fails marks the opponent with «!» in the score bar (the error in its
     tooltip) and is asked again after a second.
   - Rejected: a simulated bot with a «model» label (it would not be the model); one call per
     strike (a round trip is longer than a nail lives); thinking on (tens of seconds per move).
5. **Points go to the finishing blow.** Every strike counts towards the nail whoever lands it; the
   player whose strike drives it in gets its points. A nail a rival has started is up for grabs —
   the prompt says so.
6. **One picker, three modes.** The start screen has «Суперники (ШІ)», a searchable multi-select
   over the machine's catalogue: none is a solo round, one a duel («Грати проти …»), two or three
   an arena («Почати арену на N»). At most 3 opponents (`NAIL_GAME_MAX_OPPONENTS`). The choice is
   remembered on this device (`localStorage`, `kermanych.nail-game.opponents`); a model the
   catalogue no longer lists is dropped. The note under the picker says every opponent is a real
   model spending ~30–50 calls per round on the player's own plan.
7. **The board shows everyone.** With opponents, the score bar lists every player with a colour
   dot, best first; each opponent's hammer carries a tag with its model name; a driven nail is
   ringed in the colour of whoever drove it in (none in a solo round). The result screen ranks
   the players (ties share a place), says who won («Ви перемогли!», «Переміг …», «Нічия!»), and
   for each opponent its moves, its last round trip and its spend.
8. **Only solo rounds go on the leaderboard.** Opponents take nails, so a score against them is not
   comparable with one played alone. The result screen says so; the leaderboard is shown only
   after a solo round. The database bounds are unchanged.
9. **Esc** in the opponents' open list closes the list, not the game.

## Changes

- **core, `nail-game.ts`:** `NailGameBoard`, `NailGameMove`, `NailGameMoveAsk`,
  `NAIL_GAME_MAX_OPPONENTS` (3), `NAIL_GAME_AI_STRIKE_MS` (180), `NAIL_GAME_AI_MAX_STRIKES` (6),
  `NAIL_GAME_HIT_BONUS_MS` (600, the engine's rule the prompt states), `NAIL_GAME_BOARD_MAX_NAILS`.
  `i18n-codes.ts`: `nail_game_opponents_invalid`, `nail_game_model_unknown`,
  `nail_game_board_invalid`.
- **api:**
  - `http/nail-game.controller.ts`: `POST /nail-game/ai/warm {models}`,
    `POST /nail-game/ai/move {model, board}` → `{strikes, ms, usage?}`,
    `POST /nail-game/ai/release {models}`; 1–3 distinct model ids, the board rebuilt field by
    field before it reaches the prompt.
  - `nail-game/nail-game-ai.service.ts`: `NailGameAiService` on `RpcChatPool` (20 s turn timeout,
    cwd = home, no tools, thinking `off`); a model `ModelsService` does not list is refused.
  - `nail-game/nail-game-prompt.ts`: the contract, `buildNailGameTurn`, `parseStrikes`,
    `readNailGameBoard`.
- **ui:**
  - `lib/nail-game.ts`: `players: PlayerTally[]` replaces the round's single score;
    `createRound(field, players, rng)`, `hitNail(r, id, who)`, `swingMiss(r, who)`, `nailAt`,
    `headTop`, `Nail.by`; driven nails stay; spawn placement as in decision 3.
  - `lib/nail-game-ai.ts`: `AiSeat`, `createSeat`, `boardFor`, `takePlan`, `stepSeat`.
  - `components/nail-game/NailHammer.vue` (new), `NailSprite.vue` (driven state, owner ring, no
    hit rect), `NailGameOverlay.vue` (picker, warm/release, the seats in the frame loop, the score
    bar and result for several players).
  - `stores/nail-game.ts`: `opponents`, `setOpponents`, `catalogLoaded`.
  - `lib/api.ts`: `nailGameWarm`, `nailGameMove`, `nailGameRelease`.
  - i18n `nailGame.*` and the three error codes, `uk` / `en`.
- **README:** «Break game («Гвіздки»)» describes the hit area, driven nails and the opponents.

## Verification

Run on 2026-11-19:

- `@kermanych/ui`: 1106 tests pass (`vitest run --maxWorkers=4`). `test/nail-game.spec.ts`
  (11): the old rules on the new `players` tally, and new — a driven nail stays to the end and
  is credited to who drove it; a swing in the 18 px margin lands, one past it misses, the nearer
  of two overlapping nails wins and a driven one is not hit; the points go to the finishing blow;
  an AI seat strikes at most once per `NAIL_GAME_AI_STRIKE_MS`, scores the nail it drives, skips a
  gone nail without a swing, and is shown the right board. `test/nail-game-store.spec.ts` (6):
  at most three distinct opponents, and a model the catalogue no longer lists is dropped.
  `vue-tsc --noEmit` is clean; `test/i18n-completeness.spec.ts` passes.
- `@kermanych/api`: `test/nail-game-prompt.spec.ts` (3, new): the contract goes with the first
  board only; ids are read out of a chatty answer, ids not on the board are dropped, the plan is
  capped at 6; a malformed board is refused and unknown fields never reach the prompt.
  `tsc --noEmit` is clean. `@kermanych/core`: `test/i18n-codes.spec.ts` passes.
- **A real arena, no human** (a throwaway script driving the engine and the seats at ~60 fps
  against the preview api for 60 s): Claude Haiku 4.5 scored 69 (54 nails, 44 moves, last round
  trip 716 ms, $0.068), Claude Sonnet 5 scored 16 (11 nails, 29 moves, 1794 ms, $0.101). The one
  failed move was the turn in flight when the round's release stopped the children
  («розмову скинуто»); the overlay drops it by its round generation.
- **Live preview:** the picker lists the machine's 21 models, searchable; «haiku 4.5» filters
  to two rows; the start button reads «Грати проти Claude Haiku 4.5» / «Почати арену на N»;
  Esc in the open list closes only the list. While the opponents start, the button spins and the
  picker is locked. During the countdown and the round, the score bar shows «Ви» and the model
  with colour dots; the opponent's hammer glides to a nail with its name tag and drove one in
  (ringed blue, score 1). The hammer rests with its head raised and lies flat on the pointer when
  down. Driven nails stayed on the board and behind the result panel, ringed in the player's
  colour. The result screen ranked «Ви» 75 over Claude Haiku 4.5 0 with «Ви перемогли!», each
  line with driven nails and accuracy, the model's line with moves, round trip and spend, and
  «Раунд із суперниками не потрапляє до лідерів». Leaving during the start and leaving mid-round
  both left no omp child running for the model.
- Not verified:
  - a fair duel on screen: the preview pane does not run animation frames while nobody watches
    it, so the round clock crawled while the model's round trips ran in real time — the
    scripted human beat Haiku 75 : 0 there; the real-time arena above is the evidence of play;
  - the sound of the opponents' knocks, the light theme and the `en` texts on screen;
  - the solo save and the leaderboard against the team's project (the preview's cloud lacks the
    2026-11-18 migration, as before);
  - the desktop build.

## Documentation impact

`kermanych/README.md`, «Break game («Гвіздки»)»: the hit area, driven nails staying, the AI
opponents (the three endpoints, the hand speed, the cost, the remembered choice) and that only
solo rounds are saved. Supersedes decision 2 of `2026-11-18-nail-hammer-minigame.md` on a driven
nail fading out.
