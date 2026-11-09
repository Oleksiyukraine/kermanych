# «Аналітика»: час до PR і «Зроблено без тебе»

- **Date:** 2026-11-08
- **Branch:** `feature/self-assessment-by-table`
- **Scope:** `packages/core` (`analyticsReport`), `apps/api` (one more column read for the report),
  `apps/ui` («PR відкрито», «Динаміка», «Зроблено без тебе», i18n `uk` / `en`),
  `kermanych/README.md`. No migration, no cloud read, no new dependency.
- **Status:** the operator asked to rate Kermanych against a contest rubric (Business Impact,
  Repeatability, Automation, Quality & Control, Reusability, Innovation) and then to start closing
  the gaps «з найпростішого». This is the first step.

## Goal

The rubric's heaviest criterion, Business / Work Impact, asks how much faster the work got.
«Аналітика» already shows what the agent work costs (spend, cost per PR) and how long the agents
worked, but not how long the way to a result takes. This step adds that figure: the median
time from a session's start to its PR.

## Context

- The rest of the rubric's «measure the impact» list is already on the page:
  Посіпака's runs by outcome (`report.minion`) and findings by status, «filed» included
  (`report.findings.byStatus`). So are cost per PR (`tiles.costPerPr`) and PRs reworked after
  opening (`outcomes.prReworked`). See `docs/specs/2026-11-07-developer-analytics.md`, decision 8.
- The data is already in the ledger: `sessions.created_at` and `sessions.pr_opened_at`. For
  sessions from before recording began, the history import set `pr_opened_at`. Both reach the
  aggregation as `AnalyticsSessionRow.createdAt` / `prOpenedAt`
  (`packages/core/src/analytics.ts`).
- The «PR відкрито» tile counts the sessions whose `prOpenedAt` falls in the period and notes
  the cost of one PR. The six tiles form a 3 × 2 grid (6 in a row from 1680 px) that a seventh
  tile would break (`AnalyticsPage.vue`, `.an__tiles`).

## Decisions

1. **The figure is a median, over the PRs opened in the period:** `prOpenedAt − createdAt` of
   the same sessions the «PR відкрито» tile counts. A median rather than a mean, because one
   session reopened after a week would drag a mean far from the usual case. The same choice
   was made for «Агенти чекали на тебе» (`waitMedianMs`).
2. **A negative duration is left out.** The import takes `pr_opened_at` from the first file
   line that holds the PR URL, so in principle it can come before `created_at`. Such a pair
   is not a time to a PR, and rule 7 of the analytics spec (honest figures only) applies:
   such a row is not counted. No PRs, or none valid, → `null`, and the note is not shown.
3. **A note on the «PR відкрито» tile, not a seventh tile.** The note reads
   «$3.20 за PR · медіана 1 год 40 хв до PR». It is written the way the median wait is written
   on its own tile. A seventh tile would leave one tile alone on a third row at 1280–1440 px.
   - Rejected: a ▲/▼ comparison with the previous period. The other notes (cache share,
     parallelism, median wait) carry none either. The change over time is decision 4.
   - Rejected: a «time saved» figure. Nothing on this machine records how long the same work
     would take by hand. A guessed baseline breaks rule 7.
4. **The trend: «Час до PR», a fourth «Динаміка» metric** (asked by the operator after the
   tile note landed). Each bar is the median time to PR of the PRs opened in that bucket; the
   tooltip says how many PRs it is over («3 год · 03.11.2026 · 1 PR»). A bucket without a PR
   has no bar.
   - **No split.** Medians do not add up, so they cannot stack into model, project or session
     type segments. While «Час до PR» is picked, the split tabs are hidden and one series is
     drawn.
   - **Its own buckets: by day for 7 days, by week above.** One or two PRs a day make a daily
     median over 30 days jump with each long task. Weekly buckets over 7 days would leave one or
     two bars, so 7 days stays by day. The other metrics keep decision 4 of the analytics spec
     (by day up to 31 days).
   - Rejected: a line chart. It would need a second chart component for one metric, and the
     bars already show the trend.
5. **«Зроблено без тебе»: counts, never hours** (the operator's decisions after the «saved
   time» discussion). The operator listed parallel work, Посіпака, findings and Тестувальник as
   saved time. Only a tracker estimate gives a measured «by hand» figure. Each of the others
   would need an assumed per-item time, and the operator rejected coefficients: «краще простіше
   але чесніше».
   - The block «Посіпака і знахідки» becomes «Зроблено без тебе». Next to Посіпака's runs and the
     findings it adds a «Тестувальник» column: the tasks tested (distinct doers of the period's
     Тестувальник runs, so a task tested twice counts once) and the runs. A closing line sums it
     up: «PR від Посіпаки · знахідок стали задачами · задач протестовано».
   - Тестувальник comes from the local `sessions` rows (`tester`, `parent_session_id`). The
     verdicts in the cloud `qa_checklist` are not read: the operator ruled it out, and «N задач
     протестовано» is enough.
   - Parallel work gets no figure of its own. Паралельність is already a tile note, and the
     saving of a parallel task is that task's own; adding it again would count it twice.
   - Rejected: hours per category from coefficients set in the workspace (the operator's call);
     a sum of «saved hours».
6. **«Оцінка vs факт» is not built, for lack of data.** It would compare a tracker estimate
   (Jira `originalEstimateSeconds`, Plane time estimates, both already mirrored) with the time to
   PR. On the operator's machine (`~/.kermanych/kermanych.sqlite`, read-only, 2026-11-08), 1 of
   462 agent sessions was launched from a tracker ticket (its name starts «KEY-123 — »), and
   it has no PR. The rest come from Kermanych's own board, whose cards carry no estimate. The
   figure would rest on nothing. It is left to the operator whether to add an estimate to the
   card; that is a cloud migration, and an estimate written once the task is already going to an
   agent leans toward the agent.

## Changes

- **core, `analytics.ts`:** `AnalyticsReport.tiles.prLeadMedianMs: number | null`, the median of
  `Date.parse(prOpenedAt) − Date.parse(createdAt)` over `prs`, negatives dropped.
- **core test, `analytics.spec.ts`:** the median over the period's PRs (even count), a PR
  outside the period left out, a negative pair left out, `null` without PRs.
- **ui, `AnalyticsPage.vue`:** the PR tile's note joins the cost per PR and the median time to PR
  with « · », each shown only when the report holds it.
- **i18n:** `analytics.tile.prLead` — `uk` «медіана {time} до PR», `en` «median {time} to PR».
- **README:** the «Аналітика» list names the median time to PR and its trend.

The trend (decision 4):

- **core, `analytics.ts`:** `AnalyticsReport.dynamics.prLead`: `{ granularity, buckets,
  medianMs, counts }`. The bucket starts are computed the same way as the main buckets.
  `tiles.prLeadMedianMs` is computed from the same list of non-negative leads.
- **core test:** 7 days → seven daily medians and counts; 30 days → five weekly buckets cut at
  local Monday midnight across the October DST change, with the medians and counts per week.
- **ui, `lib/analytics.ts`:** `ANALYTICS_CHART_METRICS` (the series metrics plus `prLeadMs`),
  `isAnalyticsChartMetric`. `axisMax` treats `prLeadMs` as a time. `AnalyticsBarSeries.notes`
  holds one tooltip note per bucket. UI test: the `prLeadMs` axis below an hour is in minutes.
- **ui, `AnalyticsBars.vue`:** the tooltip appends the bucket's note. `PAD_L` 56 → 76: the
  half-way tick of a 5-hour axis, «2 год 30 хв», was cut at the left edge. This applies to «Час
  агентів» too.
- **ui, `AnalyticsPage.vue`:** the fourth tab. With it picked, the split tabs are hidden, the
  chart uses `dynamics.prLead`'s buckets, and the empty text is «За цей період PR не відкривали».
- **i18n:** `analytics.dynamics.metric.prLeadMs`, `prLeadSeries`, `prCount`, `prLeadEmpty`, in
  `uk` and `en`.

«Зроблено без тебе» (decision 5):

- **core, `analytics.ts`:** `AnalyticsSessionRow.parentSessionId`; `AnalyticsReport.tester:
  { runs, tasks }` over the Тестувальник sessions created in the period.
- **core test:** three runs on two doers → `{ runs: 3, tasks: 2 }`; a run before the period
  and an ordinary «Ревізор» fork left out.
- **api, `registry.service.ts` `analyticsRows`:** reads `parent_session_id`.
- **ui, `AnalyticsPage.vue`:** the block's title and lead, the «Тестувальник» column, the
  summary line; `.an__pair--three` keeps three columns side by side from 220 px each.
- **i18n:** `analytics.unattended.*`, `analytics.tester.*` in `uk` and `en`;
  `analytics.minion.title` removed (no longer used).

## Verification

Run on 2026-11-08:

- `@kermanych/core`: 457 tests passed (`test/analytics.spec.ts`: 12, two of them new). `@kermanych/ui`:
  994 passed, `vue-tsc --noEmit` clean.
- **Live preview** (seeded data). The preview's SQLite got three PR sessions with
  start → PR times of 1 h 30 min, 4 h and 26 h (the last one starting before the 7-day period),
  plus usage rows of $1.20, $3.40 and $5.00. The «PR відкрито» tile read «3» and
  «$3.20 за PR · медіана 4 год до PR».
- **Trend, live preview** (seeded data, written while the api was stopped: a running api writes
  its in-memory sessions back and overwrote the first attempt). Nine PR sessions between
  13 October and 7 November.
  - 7 days: daily bars on the 3rd, 5th and 7th; the tooltip «Медіана від запуску до PR: 3 год ·
    03.11.2026 · 1 PR»; the split tabs hidden.
  - 30 days: weekly bars of 9 h 30 min, 7 h, 5 h 30 min and 2 h 45 min (weeks of 12, 19 and
    26 October and 2 November), as seeded.
  - Back on «Витрати» the split tabs return.
  - Core 459 tests, UI 994, `vue-tsc` and api `tsc --noEmit` clean.
- **«Зроблено без тебе», live preview** (seeded with the api stopped: three Тестувальник runs
  on two doers, one Посіпака run with a PR, three findings, two of them filed).
  - 7 days: the Тестувальник column reads «задач протестовано 2 · запусків 3», and the
    summary «PR від Посіпаки: 0 · знахідок стали задачами: 2 · задач протестовано: 2». The
    Посіпака run started on 21 October, outside the period.
  - 30 days: «PR від Посіпаки: 1». The three columns sit side by side at 1280 px.
  - Core 460 tests, UI 994, api `test/analytics.spec.ts` 5; `vue-tsc` clean.
- Not verified: the `en` text on screen (only the keys were added beside the `uk` ones), and a
  real agent opening a PR. The preview has no `omp`, so the figures came from seeded rows only.

## Documentation impact

`kermanych/README.md`, section «Analytics («Аналітика»)», «What it shows»: the median time from
a session's start to its PR, its trend in «Динаміка», and «Зроблено без тебе».
