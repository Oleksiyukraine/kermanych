# «Аналітика»: час від запуску сесії до PR

- **Date:** 2026-11-08
- **Branch:** `feature/self-assessment-by-table`
- **Scope:** `packages/core` (`analyticsReport`), `apps/ui` (the «PR відкрито» tile, i18n `uk` / `en`),
  `kermanych/README.md`. No api change, no migration, no new dependency.
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
     parallelism, median wait) carry none either. A trend line can come later, as its own
     «Динаміка» metric.
   - Rejected: a «time saved» figure. Nothing on this machine records how long the same work
     would take by hand. A guessed baseline breaks rule 7.

## Changes

- **core, `analytics.ts`:** `AnalyticsReport.tiles.prLeadMedianMs: number | null`, the median of
  `Date.parse(prOpenedAt) − Date.parse(createdAt)` over `prs`, negatives dropped.
- **core test, `analytics.spec.ts`:** the median over the period's PRs (even count), a PR
  outside the period left out, a negative pair left out, `null` without PRs.
- **ui, `AnalyticsPage.vue`:** the PR tile's note joins the cost per PR and the median time to PR
  with « · », each shown only when the report holds it.
- **i18n:** `analytics.tile.prLead` — `uk` «медіана {time} до PR», `en` «median {time} to PR».
- **README:** the «Аналітика» list names the median time to PR.

## Verification

Run on 2026-11-08:

- `@kermanych/core`: 457 tests passed (`test/analytics.spec.ts`: 12, two of them new). `@kermanych/ui`:
  994 passed, `vue-tsc --noEmit` clean.
- **Live preview** (seeded data). The preview's SQLite got three PR sessions with
  start → PR times of 1 h 30 min, 4 h and 26 h (the last one starting before the 7-day period),
  plus usage rows of $1.20, $3.40 and $5.00. The «PR відкрито» tile read «3» and
  «$3.20 за PR · медіана 4 год до PR».
- Not verified: the `en` text on screen (only the key was added beside the `uk` one), and a real
  agent opening a PR. The preview has no `omp`, so the figure came from seeded rows only.

## Documentation impact

`kermanych/README.md`, section «Analytics («Аналітика»)», «What it shows»: the median time from
a session's start to its PR.
