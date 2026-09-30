# Team Capacity table follows the roster selection

## Goal

On Team Capacity, picking people in the roster dropdown narrows the stats and the chart, but
the table view kept a row for every person on the board. The table must show the same
selection as the chart.

## Context

`apps/ui/src/pages/ManagementCapacityPage.vue`. The dropdown writes the muted set
`excluded`; `capacityReport` (`lib/capacity.ts`) keeps muted people in `persons`/`cells` so
the chart legend can re-enable them, and leaves them out of `totals`/`summary`.
`CapacityChart` skips muted series; the page's `teamRows` mapped every `report.persons`
entry, so the table listed muted people above a «Команда» row that did not count them. The
team row's «open» column counted every issue, muted or not.

## Decisions

- Filter in the page, not in `capacityReport`: the report must keep muted people for the
  legend and the dropdown, and the chart already filters at its own render layer.
- The team row's open count is the sum of the shown rows, so the column adds up.
- Out of scope: the unscheduled/overdue chip and its flagged-issues table still count every
  person — unchanged behaviour, not part of this request.

## Changes

- `ManagementCapacityPage.vue` `teamRows`: rows only for people not in `report.excluded`;
  team row `open` = sum of those rows.
- `README.md` Team Capacity paragraph: the selection applies to chart, table and totals.

## Verification

- `pnpm typecheck` (apps/ui): no errors in the changed file (one pre-existing, unrelated
  error in `test/runtime-messages.spec.ts`).
- Throwaway happy-dom mount of the page with a stubbed Jira store (three assignees, one
  muted), switched to «Table»: the muted person has no row; removed afterwards.

## Documentation impact

`README.md` «It reads the team's capacity» — the selection wording (it said «whole team or
one assignee», which predated the multi-select roster).
