# Sidebar: project status that says whether it needs you

## Goal

The sidebar marks every project with one of two things: a green pill (agents running)
or a red dot (anything else). The red dot covers an agent blocked on the operator, a
crashed run, a finished result nobody has read, and a project with nothing in it — so
the operator cannot tell from the sidebar whether a project needs an action. Make the
indicator say which of those it is.

## Context

- `apps/ui/src/layouts/MainLayout.vue` counted `queued`/`thinking`/`tool` sessions per
  project (`runningCountById`) and passed the number to the rows.
- `components/kit/KRailItem.vue` drew a green pill for `count > 0`, otherwise a red
  `--k-danger` dot. `KWorkspaceRow.vue` drew the summed count as a muted digit.
- Red means `error` everywhere else in the app (`KStatusDot`), so the idle dot also
  contradicted the status language of the rest of the UI.

## Decisions

- **One indicator, highest priority wins** (`lib/attention.ts`), over the project's
  non-chat sessions that are not completed (`bucketOf` ≠ `completed`/`tasks`, so forks
  follow their parent and archived/merged work is out):
  1. `input` — a `waiting_input` session: warning pill with the count, pulsing.
  2. `error` — `error`/`conflict`: danger dot.
  3. `running` — `queued`/`thinking`/`tool`: success pill with the count (unchanged).
  4. `result` — `done`/`in_review` the operator has not opened since it last moved:
     warning ring, no fill.
  5. `idle` — nothing: no mark at all.
  «Needs an answer» outranks «running»: a blocked agent next to a working one is the
  one that needs the operator, and a green number must not hide it.
- **`stopped` is idle.** The operator stopped it; nothing new to read.
- **An empty project shows no mark.** Colour then only appears where something happens.
- **Unread results** are tracked per machine in localStorage
  (`kermanych.sessions.seen`: session id → the `lastActivityAt` last viewed). A result
  is unread when `lastActivityAt` is newer than both its seen mark and a baseline
  (`kermanych.sessions.seenBaseline`, written the first time the app runs with this
  feature) — without the baseline every historic `done` session would light up on
  upgrade. A session counts as viewed while it is open in «Агенти» and the window is
  visible, so a result that lands while the window is hidden stays unread.
  Rejected: a server-side `seen_at` column — a migration and API change for state that
  is personal to one operator's screen.
- **Workspace row** shows the same indicator over the sum of its projects, so a folded
  workspace still says a project inside it waits.
- The tooltip / accessible name lists every non-zero state
  («чекає відповіді: 1 · працює: 2»), because one mark carries only the top one.

## Changes

- `apps/ui/src/lib/attention.ts` — `Attention` tally, `attentionByProject`,
  `sumAttention`, `levelOf`, `isUnseen`, `describeAttention` (tooltip text).
- `apps/ui/src/stores/seen.ts` — persisted seen marks + baseline, `markSeen`, `isUnseen`.
- `apps/ui/src/pages/AgentsPage.vue` — marks the open session seen.
- `apps/ui/src/components/kit/KAttentionBadge.vue` — the indicator; used by
  `KRailItem` and `KWorkspaceRow`, which take `attention` instead of `count`.
- `apps/ui/src/layouts/MainLayout.vue` — computes attention per project / workspace.
- i18n `kit.attention.*` (uk/en) replaces `kit.railItem.running|none` and
  `kit.workspaceRow.running|none`; the kit gallery shows every level.
- `kermanych/README.md` — a paragraph on what the sidebar marks mean.

## Verification

- `apps/ui`: `vitest run` — 47 files, 549 tests pass, including the new
  `test/attention.spec.ts` (priority order, per-project tally, unread rule, forks of
  completed parents, instant-not-string timestamp comparison).
- `apps/ui`: `vue-tsc --noEmit` — only the pre-existing
  `test/runtime-messages.spec.ts` TS2352 error, same as on the base commit.
- `packages/core`: `test` — 173 pass (comment-only edit in `status.ts`).
- Smoke on a seeded preview pair (api `KERMANYCH_SEED=1 KERMANYCH_PREVIEW=1`, ui
  `VITE_KERMANYCH_PREVIEW=1`), in headless Chromium:
  - «Acme Web» (waiting_input + error + conflict + 4 running + 4 finished) wore the
    pulsing input pill «1»; its label read «чекає відповіді: 1 · помилка: 2 · працює: 4 ·
    новий результат: 4».
  - «Kermanych» (1 running + 1 unread `done`) wore the green «1»; opening the `done`
    agent in «Агенти» wrote its mark to `kermanych.sessions.seen` and dropped
    «новий результат» from the label.
  - Kit gallery rendered every level (input pill, error dot, running pill, result ring,
    idle blank) in dark and light themes; hovering a workspace row hides the pulsing
    mark (`visibility: hidden`) under the «+».

## Documentation impact

`kermanych/README.md` — Workspaces, projects and tasks: added the sidebar status marks.
