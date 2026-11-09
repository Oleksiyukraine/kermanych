# `/minion`: hand a live session to «Посіпака»

- **Date:** 2026-11-09
- **Branch:** `feature/add-minion-autonomous-mode`
- **Builds on:** `docs/specs/2026-10-23-minion-auto-run.md` (decisions 9–10: the run protocol).

## Goal

The operator's ask: a `/minion` command, also as a button beside «⋯» in the session header. From
that moment the agent makes the decisions that are still open by itself and brings the work to a
pull request — the session starts working as «Посіпака».

## Context

- «Посіпака» today starts only from the poll (`MinionService` → `SupervisorService.launchMinion`):
  a fresh session for a backlog card, stamped `minion: true` at creation.
- A minion session differs from an ordinary one in three places, all read at spawn or at a turn's end:
  - `spawnOpts` adds the no-ask overlay (`minion/ask-overlay.ts`) when the row is `minion`;
  - the `kermanych` MCP server lists `report_outcome` only for a `minion` row
    (`browser-mcp.service.ts`, `tools/list`; `listChanged: false`, so omp reads it once per child);
  - `onMinionTurnEnd` drives the verdict → docs turn → «Створити ПР» → `in_review` protocol from the
    in-memory `MinionRun`.
- Operator commands: `packages/core/src/commands.ts` (`DEFAULT_COMMANDS`, `parseCommand`), dispatched in
  `SupervisorService.deliverNow` → `runCommand`. `/compact` was the only one.

## Decisions

1. **The command turns the session into a minion run at `work`, the same protocol as a card run.**
   The row gets `minion: true` (now written by `updateSession` too) and a fresh `MinionRun`; the
   old `minionResult` is cleared, so the «потрібне рішення» mark of an earlier run goes away.
   *Rejected:* a softer mode that only tells the model not to ask. The PR would then depend on the
   model remembering it; the protocol already guarantees the docs turn, the PR turn and the result.
2. **The child is respawned.** omp reads the ask overlay and the MCP tool list only when it starts,
   so a live child is stopped (its exit is not counted as a failure) and woken on the same
   conversation, then gets the hand-over prompt. A turn in progress is cut, like ■; a question the
   agent was waiting on is dropped with it and the prompt tells it to answer it itself.
   *Rejected:* steering the hand-over into the running turn: the agent would keep its ask tool and
   would have no `report_outcome` to end the run.
3. **Its own prompt, not the card instruction.** `minionTakeoverPrompt(note)` (core `minion.ts`): the
   operator left, nobody answers; finish the task this conversation agreed on; what the operator
   already decided stands; decide the open questions by the request, the repository's patterns and
   what the operator said, and record each one; `needs_decision` only for a real blocker; check;
   commit, do not push; decisions under `## Decisions` in the PR. Then `MINION_OUTCOME_CONTRACT`.
   Text after `/minion` reaches the agent as the operator's parting words.
   *Rejected:* the «Посіпака» card instruction: it re-checks that a card still applies and refuses
   schema or API changes the operator may already have agreed in this conversation.
4. **Which sessions:** an agent session with a branch that is not native, merged, archived, a
   design, a «Синергія» prototype or a scheduled run (`minionTakeoverAllowed`, core). The rest is
   refused with `minion_takeover_unsupported`; native with the usual `native_unsupported`. A run
   that already works on its own (`work`, `docs` or `pr`, not attended) is refused with
   `minion_takeover_running`. A minion run the operator took over can be handed back with `/minion`.
5. **Its result counts toward neither the failures nor the pause.** The pause guards the poll from
   burning cards; this run was started by a person. Its result is still recorded on the session and
   the card (`minionResult`, the session report), so «Аналітика» counts it with the other minion runs.
6. **The rest is the minion's as it is:** the 2-hour time cap from the hand-over, the `[Minion]` PR
   title, the «Посіпака» mark, a place in the machine's minion cap while it runs, and a message from
   the operator making the run attended again.
7. **UI:** `/minion` («Передати Посіпаці») in the composer's command list, and a «Посіпака» icon
   button left of «⋯» for the sessions of decision 4 (blocked with the reason on a native one). The
   button sends `/minion` through the ordinary message path, so both entries are one code path.

## Changes

- **core**
  - `commands.ts`: `minion` in `DEFAULT_COMMANDS`.
  - `minion.ts`: `minionTakeoverAllowed(session)`, `minionTakeoverPrompt(note)`.
  - `i18n-codes.ts`: notice `minion_takeover_started`; errors `minion_takeover_unsupported`,
    `minion_takeover_running`.
  - `types.ts`: the `minion` field's comment.
- **api**
  - `registry.service.ts`: `updateSession` writes `minion`.
  - `supervisor.service.ts`: `sendMessage` routes `/minion` to `handToMinion`; `MinionRun.takeover`;
    `recordMinionResult` counts a takeover run as `neutral`. A hand-over whose wake or send fails
    puts the row's `minion` / `minionResult` back and drops a child woken in the minion's mode, so
    the session is not left marked «Посіпака» with nothing running.
  - `test/minion.spec.ts`: the takeover cases.
- **ui**
  - `pages/AgentsPage.vue`: the header button (`minionAction`, `useAsyncAction`).
  - `i18n/{uk,en}/index.ts`: the button, the notice and the two errors.
- **docs:** README «Посіпака» → «Hand a session over: `/minion`».

## Verification

- `vitest run test/minion.spec.ts test/compact.deliver.spec.ts` (api): 41 passed, three of them new:
  - a running operator session given `/minion <note>` is stopped without turning `error`, respawned
    with the no-ask overlay, gets `minionTakeoverPrompt(note)` + the outcome contract, and runs
    `ready` → «Створити ПР» (with the `[Minion]` title rule) → `in_review` with `minionResult: pr`,
    leaving the machine's failure count at 1;
  - a hand-over turn without a verdict lands at `in_review` with `no_outcome` and does not raise
    the failures or pause;
  - a chat is refused with `minion_takeover_unsupported` and stays non-minion; a poll-started run
    still working is refused with `minion_takeover_running` and nothing respawns.
- core `vitest run`: 455 passed (includes the code-list exhaustiveness spec).
- ui `vitest run test/i18n-completeness.spec.ts test/minion-view.spec.ts`: 26 passed.
- `tsc --noEmit` (api) and `vue-tsc --noEmit` (ui): clean.
- Live preview (seed data): the bot button shows left of «⋯» on an agent session; `/` in the
  composer lists «Передати Посіпаці /minion» with the «команда» badge. Clicking the button on the
  seed's in-place session reached `handToMinion`, whose wake failed with the seed's own
  «project is not on fix/prod-hotfix» as a toast, and the header showed no «посіпака» mark
  afterwards (the restore).

Not verified: a real omp child taking the hand-over end to end (the preview has no omp on PATH),
the English UI strings on screen, and the native session's blocked button.

## Documentation impact

`kermanych/README.md`, section «Посіпака» (autonomous runs): the hand-over command and button.
