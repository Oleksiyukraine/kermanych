# «Аналітика»: a developer's own analytics of their agent work

- **Date:** 2026-11-07
- **Branch:** `feature/add-developer-analytics-menu`
- **Scope:** `packages/core` (the report type and the pure aggregation), `apps/api` (local ledger
  tables, live recording, a one-time history import, `GET /api/analytics`), `apps/ui` (the
  «Аналітика» tab, its page and charts, the ЦУК place, i18n `uk` / `en`), `kermanych/README.md`.
  No cloud migration, no new dependency.
- **Status:** proposed by the agent without an interview — the operator asked for a creative
  proposal («Коли зробиш аналіз одразу пропонуй рішення, не розпитуй у мене»). Waiting for the
  operator's go-ahead.

## Goal

A new top-level menu item «Аналітика», for the developer. No further input: the content is this
document's proposal. The question the screen answers is **«how do I work with my agents, what does
it cost, and where is the time going?»** — spend, agent time, the time agents spend waiting on me,
outcomes (PRs), models, projects, and the rhythm of the week.

## Context

- **No earlier attempt.** No spec, commit or code mentions analytics (`git log --all --grep`,
  `docs/`, README). The only analytics-like screen is Менеджмент → Team Capacity
  (`pages/ManagementCapacityPage.vue`, `lib/capacity.ts`): workspace-scoped, built on tracker
  worklogs, aimed at managers.
- **The top nav** is the `VIEWS` table in `layouts/MainLayout.vue:1051-1072`: Агенти, Дошка, Чат,
  Дизайн, Синергія, Менеджмент, ШІ-команда. The live preview at 1280 px has room for one more
  segment. ЦУК's `places()` (`stores/cuk-chat.ts:160-180`) repeats the list.
- **Local data that exists today** (`apps/api/src/registry/registry.service.ts:365-645`):
  - `sessions`: `created_at`, `last_activity_at`, `kind` (`agent|discussion|task|review|chat`),
    flags (`minion`, `tester`, `design_dir`, `synergy`, `deep_analysis`, `schedule_id`), `model`,
    `effort`, `runtime`, `native`, `pr_opened`, `pr_url`, `minion_result`, and `usage` — ONE
    lifetime total `{input, output, cacheRead, cacheWrite, cost}` per session.
  - `session_findings` (kind, status, `created_at`), `schedule_runs`.
  - Finished sessions stay (`status='merged'`); a deleted session takes its row and findings with it.
- **What is missing for any time-based figure:**
  - no per-turn or per-day usage: `addUsage` folds each live turn into the lifetime total
    (`registry.service.ts:1228-1243`, called at `supervisor.service.ts:2282-2289`);
  - no status history: only the current status is stored; `status_outbox` is latest-wins and only
    for sessions with a card;
  - no finish time, no PR time.
- **The harness files hold the history.** Each omp session file (managed and native omp) has one
  `type:"message"` line per assistant message with a line `timestamp`, `message.timestamp`,
  `model`, `duration` and `usage` incl. `cost.total`. Checked on this machine: 452 of 467 sessions
  have an omp file; 445 files exist, 497 MB in total, the largest 22.6 MB; every assistant
  message sampled carries a timestamp. Claude files carry per-message `timestamp` and usage without
  cost; codex rollouts carry cumulative `token_count` events (parsers:
  `apps/api/src/native/native-session.service.ts:100-172`).
- **A fork's file repeats its parent's history** — the reason live turns only are counted
  (`supervisor.service.ts:2276-2281`).
- **Cost is unknown** for native claude and codex sessions (`lib/native-session.ts:55-59`).
- **Cloud.** `tasks.session_report` holds only the latest session of a card; there are no times
  but `created_at`, and `updated_at` moves with the 45 s keepalive. Every member can read every
  task of the workspace. Egress on the Free project is the binding constraint
  (`stores/board.ts:197-201`, `packages/cloud/src/tasks.ts:10-15`).
- **The status stream.** Every status change of every session, managed and native, passes through
  `supervisor.events$` `session_update` (the stream `CloudSyncService` already subscribes to,
  `apps/api/src/cloud/cloud-sync.service.ts:46-52`).
- **No chart library.** The policy is hand-rolled SVG / CSS grid on `--k-*` tokens
  (`components/capacity/CapacityChart.vue:100-107`, `components/risk/RiskMatrix.vue`).
- **Async rules** (`README.md` → Design → Async states): `useLoadPhase` + `KSkeleton`, a scope
  switch clears the data, polling never lights the progress bar.

## Decisions

1. **Personal and machine-local.** «Аналітика» shows the work run on THIS machine, read from the
   local SQLite. Nothing is written to or read from the cloud; nothing leaves the machine. No role
   gate: every signed-in user sees their own data.
   - Rejected: a team view or a leaderboard built from cloud `tasks` (it reads as surveillance,
     team numbers belong to Менеджмент; the cloud keeps only the latest session per card and no
     times; it costs egress). Rejected: syncing the ledger to the cloud to add up several machines
     (a migration and egress for a rare case; the screen says «на цьому компʼютері»).
2. **A top-level tab «Аналітика», last in the nav, after «ШІ-команда»; route `/analytics`.** One
   scrollable page, no rail: the blocks below are one story read top to bottom. ЦУК's `places()`
   gains the tab, so «відкрий аналітику» works.
   - Rejected: a Менеджмент section (workspace-scoped, manager-facing); a rail of sub-pages (each
     block is one screen-height; splitting hides the comparisons).
3. **Scope follows the top switcher, with «everything» when nothing is picked.** A selected project
   → that project; a selected workspace → its projects on this machine; nothing selected → every
   project on this machine, local-only ones included. The header names the scope («Усі проєкти» /
   the workspace / the project). Unlike «Агенти», no selection is required.
4. **Periods: 7 днів (default), 30 днів, 90 днів, 12 місяців**, each ending now, chosen with a
   `KChipSelect`; the pick is remembered in localStorage. Every headline figure is compared with
   the previous period of the same length (▲/▼ and the percentage; nothing when the previous
   period has no data). Bars are by day up to 31 days (`DAY_GRANULARITY_MAX_DAYS` of
   `lib/capacity.ts`), by week above. Day boundaries are the machine's time zone.
   - Rejected: a free date range (the presets answer the questions; a range picker is weight for
     little gain).
5. **A local ledger, recorded live from now on.** Three additive tables and one column:
   - `usage_hours` — spend per UTC hour, keyed by `(hour, session_id, model)`, with `project_id`,
     `runtime`, `native`, `kind` and the session flags copied in; values `calls`, `model_ms`,
     `input`, `output`, `cache_read`, `cache_write`, `cost`. A managed session adds each live `turn`
     entry where `addUsage` is called today (same figures as the «Сесія» tab). A native session's
     rows are rebuilt from its harness file after each turn, where `setUsage` reads that file
     today (`native-session.service.ts:657-682`).
   - `activity_spans` — `(session_id, project_id, kind, started_at, ended_at)`, `kind` ∈
     `working` (`thinking`/`tool`), `waiting` (`waiting_input`), `queued` (waiting for an agent
     slot). Written by an `AnalyticsService` subscribed to `supervisor.events$`: a span opens when
     the coarse status enters the kind and closes when it leaves. On a clean shutdown open spans
     close at that moment; after a crash, at start, an open span closes at its session's
     `last_activity_at`.
   - `analytics_meta` — one row: `ledger_started_at`, the history import's state and counts.
   - `sessions.pr_opened_at` — set beside `pr_opened` (`supervisor.service.ts:2301-2306`).

   The ledger outlives a deleted session (the money was spent) and goes with a removed project.
   Rows older than 400 days are pruned at start.
   - Rejected: one row per assistant message (≈100 rows per prompt; a heavy month is hundreds of
     MB); parsing every session file on each page open (497 MB on this machine); the cloud status
     outbox (latest-wins, card sessions only).
6. **A one-time history import, so the page is not empty on day one.** In the background after the
   api starts, one file at a time and yielding between files, every session file still on disk is
   read through the native parsers into `usage_hours` (omp, claude and codex) — only messages
   before `ledger_started_at`, and for a fork (`parent_session_id`) only messages after its own
   `created_at`, so nothing is counted twice. From omp files it also rebuilds `working` spans: a
   span runs from a user message to the last assistant or tool message before the next user
   message. For a session with a `pr_url` and no `pr_opened_at`, the import sets `pr_opened_at` to
   the timestamp of the first file line that contains that URL. `waiting` and `queued` cannot be
   rebuilt: those figures start at `ledger_started_at`,
   and the page says so («Очікування рахується з 7 листопада»). While the import runs the page shows
   «Імпорт історії: 120 з 445 сесій». Sessions without a file count in the session figures but
   not in spend; the page states how many.
   - Assumption to measure: the import of ~500 MB finishes in under a minute on this machine and
     does not stall the event loop. Implementation logs its duration, file count and bytes, and
     the result is written into Verification below.
7. **Honest figures only.** A number the data does not hold is not shown, not guessed: unknown cost
   (native claude / codex) is left out of the dollar totals and named beside them («+ 1,2 млн
   токенів claude/codex без ціни»); a period without data says «Немає даних за цей період»; spend
   that never had a session row — ЦУК, the Менеджмент chat, release notes, branch naming — is not
   counted, and the page footnote says so.
8. **The page, top to bottom:**
   1. **Toolbar:** scope name, period chips, the coverage note (decisions 6 and 7).
   2. **Six headline tiles**, each with the change against the previous period:
      - **Витрати** — dollars;
      - **Токени** — total, and the cache share `cacheRead / (input + cacheRead)`;
      - **Час роботи агентів** — the sum of `working` spans, and **паралельність** = that sum ÷ the
        wall time with at least one agent working («×2,4»);
      - **Агенти чекали на тебе** — the median from `waiting_input` to your answer, and the total;
      - **Сесій запущено** — sessions created in the period;
      - **PR відкрито** — sessions whose `pr_opened_at` falls in the period, and the cost per PR
        (the lifetime spend of those sessions ÷ their count).
   3. **Динаміка** — stacked bars per day/week. Metric: Витрати | Токени | Час агентів. Split by:
      модель | проєкт | тип сесії (агент, чат, обговорення, рев'ю, Тестувальник, Посіпака, дизайн,
      синергія, розклад). Up to 8 series, the rest as «інші»; a legend toggles series.
   4. **Ритм тижня** — a 7 × 24 heat map (weekday × hour) of agent working time.
   5. **Результати** — the agent sessions created in the period by where they are now: PR
      відкрито, завершено без PR, в роботі, зупинено, помилка, конфлікт; and «PR з
      доопрацюванням»: how many PRs had more `working` time after `pr_opened_at`.
   6. **Моделі** — a table: model, calls, tokens, cache share, cost, cost per call, mean model time
      per call.
   7. **Проєкти** — a table, shown when the scope holds more than one project: sessions, PRs,
      cost, agent time, waiting time.
   8. **Найдорожчі сесії** — the top 10 by spend in the period; a row opens the session the way
      ЦУК's «Відкрити сесію» does (`stores/cuk-chat.ts:510-524`); a deleted one reads «видалена
      сесія» and opens nothing.
   9. **Посіпака і знахідки** — Посіпака's runs by outcome (`minion_result.outcome`), and findings
      reported in the period by kind and by status (open / filed / dismissed).
   - Rejected: generated «insight» sentences (a model writing conclusions over figures invites
     fabricated claims); QA verdicts of «Тестувальник» (they live in the cloud `qa_checklist`, the
     heavy blob the egress rule keeps out of lists); subscription-window history from `omp usage`
     (percent of a resetting window, already in the account tile).
9. **One endpoint, aggregated in the api.** `GET /api/analytics?period=7d|30d|90d|12m&projectIds=…&tz=…`
   returns an `AnalyticsReport` (a `packages/core` type) for the period and the previous one. The
   aggregation is a pure core function over the ledger rows the registry reads, so it is unit-tested
   without a database. The page loads it on open and on a scope or period change (skeleton, stale
   replies dropped), and re-reads it every 60 s while visible, without the progress bar.
   - Rejected: sending raw rows to the browser and aggregating there (more bytes over the socket
     for the same result, and the import state lives in the api anyway).
10. **Charts are hand-rolled** — `components/analytics/`: a stacked-bar SVG on the
    `CapacityChart.vue` model, a CSS-grid heat map on the `RiskMatrix.vue` model, the tiles and
    tables from the kit (`KTable`). The `#/kit` gallery gains an «Аналітика» section showing them
    with sample data.
    - Rejected: a chart library (against the stated policy; bundle weight).

## Implementation

- **core:** `analytics.ts` — `AnalyticsPeriod`, `AnalyticsReport`, the ledger row types, and
  `analyticsReport(rows, opts)`: period and bucket boundaries in a time zone (DST-safe), span
  clipping and union (паралельність), splitting spans by hour for the heat map, medians, deltas,
  the «інші» fold, outcome buckets. Exported from the package index.
- **api:**
  - `registry.service.ts` — the tables and column of decision 5 (`CREATE TABLE IF NOT EXISTS` /
    `ALTER TABLE ADD COLUMN`, as today), upsert/insert/read methods, prune, the project-removal
    cleanup, `pr_opened_at` beside `prUrl`.
  - `analytics/analytics.service.ts` — the `events$` subscriber writing spans, shutdown/crash
    closing, the history import (decision 6) using the parsers of `native-session.service.ts`
    extended with per-message timestamps.
  - `supervisor.service.ts` — the `usage_hours` add next to `addUsage`; native rebuild next to
    `setUsage`.
  - `analytics/analytics.controller.ts` — `GET /api/analytics`; a module registered in the app.
- **ui:**
  - `router/routes.ts` — `{ path: 'analytics', name: 'analytics', component: AnalyticsPage }`.
  - `layouts/MainLayout.vue` — a `VIEWS` row after `ai-team`; `stores/cuk-chat.ts` — the place.
  - `pages/AnalyticsPage.vue`, `components/analytics/*` (bars, heat map, tiles), `lib/analytics.ts`
    (scope → project ids, formatting, series colours), `lib/api.ts` (`analytics()`).
  - i18n: `common.nav.viewAnalytics` and an `analytics` namespace in `uk` and `en`.
- **Tests:** core `analytics.spec.ts` — bucket boundaries across the Kyiv DST change, a span
  crossing midnight and the period edge, union of overlapping spans, the median of an even count,
  the previous-period delta with an empty previous period, unknown cost kept out of the dollars;
  api — the import skips messages after `ledger_started_at` and a fork's inherited messages, and
  is idempotent on a second start; a span left open by a crash closes at `last_activity_at`.

## Verification

- `pnpm --filter @kermanych/core test`, `pnpm --filter @kermanych/api test`,
  `pnpm --filter @kermanych/ui test` (at most 4 workers), and the type checks.
- The live preview: the tab is in the nav and lit on `/analytics`; skeleton, then figures; switching
  project clears and reloads; an empty period shows the empty text; a top session opens in «Агенти».
- A run of a real agent turn moves the spend, the working time and, after a question from the
  agent, the waiting time.
- The history import on this machine's registry copy: duration, files, bytes (decision 6).

## Documentation

`kermanych/README.md` gains a section «Аналітика»: what it shows, that it is personal and local,
where the figures come from, the history import and what it cannot rebuild, what is not counted.
