# Date picker: hovering a neighbour-month day no longer switches the month

- **Date:** 2026-09-30
- **Branch:** `fix/calendar-month-switching-fix`

## Goal

In the calendar popup, moving the pointer over a faded day of the previous or next month
switched the displayed month. The month must change only on the arrow buttons (or the
keyboard / a typed date).

## Context

`kermanych/apps/ui/src/components/kit/KDateField.vue` derived the month on screen from
`activeIso` — the highlighted day — and every cell's `mouseenter` set `activeIso`. Hovering
1 July in June's grid therefore redrew the grid as July.

## Decisions

- Split the state: `activeIso` stays the highlight (hover and keyboard share it, Enter picks
  it); a new `viewIso` — a day inside the displayed month — drives the grid and title.
- Hovering an in-month day updates both, so a month step still starts from the hovered day;
  hovering a faded day updates only the highlight.
- `stepMonth` steps from `viewIso`, not `activeIso`: from a hovered faded 1 July in June,
  «next month» must land on July, not August.
- Keyboard week moves (ArrowUp/Down), PageUp/PageDown, typing a date and opening still move
  the view with the highlight — the keyboard crossing a month edge is intentional.
- Rejected: skipping `mouseenter` on faded days — they would lose the shared hover highlight
  while the highlight stays on another day, so a click and Enter would disagree visually.

## Changes

- UI: `KDateField.vue` — `viewIso` state, `moveTo()` (highlight + view) and `hover()`
  (highlight; view only for in-month days); all former `activeIso` writers use one of them.
- No API, data, i18n or migration change.

## Verification

- Throwaway vitest (happy-dom, `@vitejs/plugin-vue`) mounting `KDateField` on 30 June 2026:
  hovering faded 3 July keeps «Червень 2026» and highlights the cell; «next» then shows
  «Липень 2026»; hovering faded 29 June in July keeps July; clicking a faded day still
  commits it. Passes with the fix; fails without it (`Expected "Червень 2026", Received
  "Липень 2026"`). Removed afterwards — the UI suite has no component-mount setup.
- `pnpm --filter @kermanych/ui typecheck` — no error in `KDateField.vue`; the remaining
  errors come from unbuilt workspace packages and pre-existing test typings.

## Documentation impact

None — the project docs do not describe the date picker's hover behaviour; the rationale
lives in the component's comments.
