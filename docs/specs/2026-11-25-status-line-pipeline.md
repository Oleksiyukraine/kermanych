# Status line as a stage pipeline

## Goal

Rework the session status line built by `docs/specs/2026-11-23-pr-feedback-loop.md` (decisions
12–15). The operator asked for a status display «like GitHub / GitLab» and expected a stage
pipeline (GitLab's pipeline graph); what shipped is a sentence per status that sits beside every
older status display, so one status is printed four times. This task replaces the line with a
pipeline of the task's stages and removes the duplicates.

## Context

What the operator sees today for one working session (screenshot from the operator, 2026-11-25;
`docs/design/2026-11-24-status-line-redo/screens/current-in-review@1440.png`):

- the «Агенти» list card: `● думає` (`KStatusDot` + `statusLine` prop, `KSessionCard.vue:59`)
  and right under it `◆ думає` (`KStatusLine variant="compact"`, `KSessionCard.vue:76`);
- the session header: `omp · думає` (`AgentsPage.vue:272`, `:510`);
- under the tab row: `◆ Думає · тиша <1 с` (`KStatusLine` full, `AgentsPage.vue:474`);
- over the composer: `◆ думає · тиша <1 с` (`KStatusRow`, `KPanel.vue:177`);
- in the log: the stall banner (`KPanel.vue:158-166`) and the error banner (`KPanel.vue:151-154`).

Decision 12 of the earlier spec kept every older display «until the operator is satisfied», and
rejected a lifecycle stepper because it «lies on the second review round». The merge-box (CI,
review, conflicts, loop) shows only for `in_review` with a GitHub loop, so in practice the line
is a single sentence.

## Decisions

Settled with the operator one question at a time on a prototype
(`docs/design/2026-11-24-status-line-redo/`).

1. **A stage pipeline, as in GitLab.** Rejected: a GitHub merge-box over the composer; a coloured
   state pill beside the title (GitHub «Open / Merged»); the pipeline with the merge-box rows
   unfolding under it.
2. **Stages: `Задача → Агент → ПР → CI → Ревʼю → Злиття`.** Each stage is `done` ✓, `running`
   (spinner), `waiting` ● (yellow), `failed` ✗ or `todo` ○, with an optional short note under its
   name. The *work stage* is «Агент» while the session has no PR and «Ревʼю» once `prOpened` is
   set: the agent working on review feedback never sends the pipeline back to «Агент» (this is
   what answers decision 12's «lies on the second round»).

   | Session | Pipeline | Action on the right |
   |---|---|---|
   | `queued` | **Задача** ● `черга · 2 з 2 зайнято · 3 хв` | Запустити зараз |
   | `thinking` / `tool` | work stage spinner: `думає` / `bash: pnpm test`, `тиша 12 с`; a stall turns it ✗ `тиша 1 хв` | Перезапустити (stall) |
   | `waiting_input` | work stage ● `чекає відповіді · 5 хв` | Відповісти |
   | `error` | work stage ✗ `помилка` (full reason in the tooltip) | Відновити / Увійти |
   | `stopped` | work stage ○ `зупинено · 12 хв тому` | Продовжити |
   | `done` (no PR) | Агент ✓ → **ПР** ● `можна створювати` | — |
   | `conflict` | no PR: Агент ✗; PR open: Злиття ✗ — `конфлікт з <base>` | Розвʼязати |
   | `in_review` | ПР ✓ `#41` → CI → Ревʼю → Злиття from `PrLoopState` (below) | Продовжити петлю / Передати агенту |
   | `merged` | every stage ✓ | — |

   With a PR, the stages after ПР come from the loop state:
   - **CI** — `pending` running `3/4`; `success` ✓ `4/4`; `failure` ✗ `1 з 4 впала`; stuck ●
     `висить N хв`; no checks ✓ `немає перевірок`.
   - **Ревʼю** — `approved` ✓; new comments ● `N коментарі`; `changes_requested` ● `запитано
     зміни`; none ● `чекає ревʼю`; the loop's turn running: spinner `агент виправляє · коло N`;
     paused ✗ `петля на паузі`.
   - **Злиття** — ready to merge ● `можна зливати`; `mergeable` conflict ✗ `конфлікт з <base>`;
     PR closed unmerged ✗ `ПР закрито`; merged ✓ (and Ревʼю ✓ with it).
   - **No loop data** (non-GitHub, no `GIT_TOKEN`, not polled yet): CI and Ревʼю grey `немає даних`,
     the reason in the tooltip.

   Sessions of `kind` other than `agent` (chat, discussion, review) have no branch and no PR: the
   full line shows only their work stage; their card keeps the single `● статус` row.
3. **One place per status: the older displays go.**
   - `KStatusRow` over the composer is gone from «Агенти».
   - The list card's two status rows (`● думає` and the compact line) become one row: the
     pipeline as small dots and the current stage's name and note.
   - The session header shows only the harness (`omp`), not `omp · <status>`.
   - KPanel's stall banner is gone from «Агенти»: the pipeline shows the silence in red with
     «Перезапустити».
   - «Синергія», «Дослідження» and the «Менеджмент» assistant host KPanel without a status line,
     so they keep `KStatusRow` and the stall banner (KPanel's `statusLine` prop switches both off
     for a host that shows the line). Found during implementation: deleting them outright would
     leave those sessions with no live status and no stall restart.
   - Kept: KPanel's error banner (the full error text where it happened in the log) and the log's
     `Думаю…` typing indicator.
   Rejected: dropping the error banner too; dropping only the compact row and `KStatusRow`.
4. **Details in a popover.** A click on **CI** or **Ревʼю** opens a popover under the stage with
   that stage's rows from the old merge-box: failed checks with links; comments held back
   («не передано: автор без доступу») each with «Передати»; the loop's mode, round, last send
   and phase. «Передати агенту» and «Продовжити петлю» sit on the right of the pipeline, with
   the other actions. Other stages carry a tooltip with the full text.
   Rejected: a collapsible row under the pipeline (4–5 rows tall on review); tooltips only (loses
   the per-comment «Передати» of the earlier decision 3).
5. **Narrow pane: stages collapse to their node.** The current stage and any failed one keep the
   name and note; the others shrink to the circle, name in the tooltip. When the buttons do not
   fit beside the pipeline (two loop actions in a narrow pane), they drop to a second row under
   it. Rejected: horizontal scroll; wrapping the pipeline itself.
6. **Defaults the operator accepted:**
   - `KStatusLine` is rewritten into the pipeline (full under the tab row, compact dots in the
     card); no second component.
   - The merge-box fold and its device preference `kermanych.statusLine.collapsed` are removed.
   - Board cards are unchanged (loop data exists only on the assignee's machine).
   - Decisions 12–15 of `docs/specs/2026-11-23-pr-feedback-loop.md` are superseded by this
     document.

## Changes

- `apps/ui/src/components/kit/KStatusLine.vue` — rewritten: stage model, pipeline (full),
  dots + label (compact), CI / Ревʼю popovers, narrow collapse.
- `apps/ui/src/lib/status-line.ts` — the stage model (`pipelineOf(session, loop, now)`), pure and
  unit-tested; `statusLineCollapsed` removed.
- `apps/ui/src/components/kit/KSessionCard.vue` — one status row: the compact pipeline for agent
  sessions, `● статус` for the rest.
- `apps/ui/src/components/kit/KPanel.vue` — `statusLine` prop: no `KStatusRow`, no stall banner.
- `apps/ui/src/pages/AgentsPage.vue` — header shows the harness only; KPanel gets `statusLine`.
- `apps/ui/src/pages/KitGalleryPage.vue` — caption of the status-line samples.
- i18n `uk` / `en`: `statusLine.stage.*`, `statusLine.note.*`; the old `statusLine.*` sentences,
  `statusLine.compact.*` and the merge-box-only `prLoop.*` keys (`ended`, `ready`, `row.ci` /
  `row.review` / `row.conflicts`, `mergeable`, `compact`) removed.
- `apps/ui/test/status-line.spec.ts` — `pipelineOf` per row of decision 2.
- `kermanych/README.md` — the «Status line» paragraph rewritten.
- The prototype route `/__design/status-line/variants` and `pages/design/status-line/` deleted.

## Verification

- `pnpm typecheck` (vue-tsc) in `apps/ui`: clean.
- `vitest run --maxWorkers=4` in `apps/ui`: 109 files, 1133 tests passed, including
  `test/status-line.spec.ts` (12): queued, working and stalled, waiting / error / stopped, done
  without a PR, conflict before and after the PR, review with CI running and comments, failed CI
  with a paused loop, ready to merge, the second review round staying on «Ревʼю», no loop data,
  merged, non-agent kinds.
- Live preview (seeded): «Агенти» at 1440 and at 1000 px — one status row per agent card, the
  header reads `omp` only, no live row over the composer, the pipeline under the tabs; at 1000 px
  the non-current stages shrink to nodes
  (`docs/design/2026-11-24-status-line-redo/screens/implemented-*.png`). Kit gallery: every status
  and loop phase in both variants at a ~400 px column; two loop buttons drop under the pipeline;
  the «Ревʼю» popover opens with the review decision and the loop row and closes on Esc.
- Not verified: a real GitHub PR polled by the loop (the preview has no loop states outside the
  gallery fixtures); the light, matrix and hermes themes; the per-comment «Передати» click
  against the api.

## Documentation impact

`kermanych/README.md`, «Status line» paragraph under «Status flows back»: describes the pipeline,
the popovers, and that the older displays are gone.
