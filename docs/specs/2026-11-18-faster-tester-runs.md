# Faster «Тестувальник» runs

- **Status:** implemented on `feature/speed-up-tester-runs`.
- **Scope:** `packages/core` (tester defaults, settings shape, contract), `apps/api` (tester settings
  columns, launch model and effort), `apps/ui` (TesterPanel model/effort pickers, i18n), README.
- **Builds on:** `docs/specs/2026-11-04-qa-tester-agent.md` (decision 14 «Not now: model / effort
  choice» is reversed here), `docs/specs/2026-11-06-synergy.md` (decision 3, the fast default).

## Goal

The operator (2026-11-18): a tester run is very slow, while it only walks a flow that is already
known and written down as the QA checklist. Make runs faster.

## Context (before this change)

`runTester` (`apps/api/src/supervisor/supervisor.service.ts`) created the child row with no `model`
/ `effort`, and `startTester` spawned omp without `--model` / `--thinking`, so every run went on
omp's own default — on this machine `anthropic/claude-opus-5-5` at `high`.

Measured on the 12 most recent tester transcripts of this machine (`~/.omp/agent/sessions`, rows
`sessions.tester = 1`):

| | |
|---|---|
| run length | 3.4–12.5 min (older runs up to 19.7) |
| model turns per run | 52–203, ~7–10 per checklist item |
| share of wall time waiting for the model | ~85–95 % |
| median latency per model turn | 2.1–3.4 s (opus-5-5, `high`) |
| tool time per run | 0.3–3.4 min, mostly `browser_wait_for` on the app itself |
| start lag (row created → first message) | < 1 s |

So the time is the number of round trips times the latency of one. Per turn the model writes ~260
output tokens with ~140 characters of thinking: the reasoning level buys nothing here, the model's
per-turn latency does. Across the machine, `claude-sonnet-5-5` at `low` answered a turn in a median
1.4 s (33 Синергія turns) against 3.8 s (2.5 s for short outputs) for `claude-opus-5-5` at `high`
(13 575 turns).

Of 1 386 tester turns, 336 (24 %) were only an observation (`browser_snapshot`, `browser_evaluate`,
`browser_wait_for`, `browser_screenshot`) right after an action made in the previous turn, and 50 a
lone `report_qa_result`. omp runs the tool calls of one response one after another, in order (the
results of such pairs land in call order, milliseconds apart), so the two could share a turn.

## Decisions

### 1. A fast default model and effort for every run

`TESTER_DEFAULT_MODEL = "claude-sonnet-5-5"`, `TESTER_DEFAULT_EFFORT = "low"` (`packages/core/src/tester.ts`),
the same pair Синергія starts on. A model this machine's catalogue lacks falls back to the project's
default model, and with neither to omp's own — Синергія's rule.

The model and effort are stored on the tester's session row (`sessions.model`, `sessions.effort`), like
any session's, so a run replayed by the slot queue after an api restart (`restoreSlotQueue` →
`startTester`) starts on the same pair.

Rejected: keeping omp's default (the cause); a cheaper model such as Haiku by default (unmeasured on
this flow — judging «did the app do what the item says» is the job; Sonnet is the precedent already
trusted for live UI work).

### 2. The operator can choose them per project, on this machine

`TesterSettings` gains `model` (`""` = Kermanych's default above) and `effort` (`""` = `low`), stored
with the other tester settings in SQLite `tester_settings` (two additive columns), edited on the
«Тестувальник» page (project scope) with the same pickers as Синергія's start form. A slower, stronger
model stays one choice away when a project needs it.

Rejected: a workspace-wide cloud setting (the rest of the tester's settings are machine-local; a new
cloud column and RLS for one choice); no choice at all (the quality trade-off would be locked in).

### 3. The contract asks for fewer round trips

The appended contract (`testerContract`, cannot be dropped by an instruction override) gets three
rules, named for the platform's tools:

- a known flow, not an investigation: open code or docs only when an item does not say where to go,
  and do not repeat a check already observed;
- calls that follow each other go into one response (they run in order): an action with the check of
  its result, an item's `report_qa_result` with the first action of the next item; a separate step
  only when the next call depends on what the previous one shows;
- read the page with the snapshot / wait tools; a screenshot only for something visual or a failed
  item.

Rejected: action tools that return a snapshot themselves (changes every session's browser tools and
grows the context of every agent, not only the tester's).

## Changes

**`packages/core`** — `tester.ts`: `TESTER_DEFAULT_MODEL`, `TESTER_DEFAULT_EFFORT`,
`TesterSettings.model` / `effort`, `EMPTY_TESTER_SETTINGS`, the three contract rules; exported from
`index.ts`.

**`apps/api`**
- `registry.service.ts`: `tester_settings.model`, `tester_settings.effort` (additive), read and written by
  `getTesterSettings` / `setTesterSettings`.
- `http/tester.controller.ts`: `normalizeTesterSettings` trims `model`, refuses an unknown `effort`.
- `supervisor.service.ts`: `runTester` resolves the model (setting → default → project default) and the
  effort (setting → `low`) and stores them on the child row; `startTester` spawns with them.

**`apps/ui`** — `components/settings/TesterPanel.vue`: «Модель» and «Зусилля» selects (catalogue models,
the efforts the chosen model admits; a model that does not admit the chosen effort resets it to the
default); i18n `tester.panel.*` uk/en; `i18n/*/agent-about.ts` «Що Керманич додає сам» names the speed
rules and the default model.

**README** — «Тестувальник» (QA runs) → «Model and speed».

## Verification

- `packages/core`: `vitest run test/tester.spec.ts` — 26 passed (the existing «no `browser_` in a
  Mobile contract, no `device_` in a web one» check covers the platform names of the new rules).
- `apps/api`: `vitest run test/tester.spec.ts` — 15 passed, including the new «runs on the fast default
  pair, on the project's settings when chosen, and on the project default when the catalogue lacks the
  model» (spawn opts `model` / `thinking` and the child row) and the settings route storing `model` /
  `effort` and refusing `effort: "turbo"`.
- `apps/api` `tsc --noEmit`: clean. `apps/ui` `vue-tsc --noEmit`: only the pre-existing
  `Cannot find module '@kermanych/api'` in `src-electron/*` (api not built in this worktree), nothing
  in the changed files.
- Live preview (web build, seeded demo): the «Тестувальник» page of «Acme Web» shows «Модель —
  За замовчуванням — Claude Sonnet 5.5» and «Зусилля — За замовчуванням — Низький»; picking Claude
  Opus 5.5 offers its efforts low…max; Opus 5.5 + «Середній» saved, survived a reload.

Not verified: a real tester run on the new default — the speed-up itself is an estimate from the
per-turn latencies above (Sonnet 5.5 at `low` measured on 33 turns only) plus the expected drop in
turns, not a measured run. The desktop build (where web-project runs happen) was not started.

## Documentation impact

- `kermanych/README.md`, «Тестувальник» (QA runs) → «Model and speed».
- `docs/specs/2026-11-04-qa-tester-agent.md`, decision 14: the «Not now: model / effort choice» line
  points here.
- This spec.
