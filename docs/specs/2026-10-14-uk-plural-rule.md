# Ukrainian plural forms in the UI

- **Date:** 2026-10-14
- **Task:** agent report from branch `feature/create-pr-impruvements` (session
  «create-pr-impruvements»): three-form uk messages pick the wrong form.
- **Scope:** `kermanych/apps/ui` (`src/boot/i18n.ts`, a new spec).

## Goal

Ukrainian messages with three `|`-separated forms are written as `one | few | many`. They must
render form 1 for n = 1, 21, 31…; form 2 for n = 2–4, 22–24…; form 3 for n = 0, 5–20, 25–30….
`management.chat.todoAdded` with one item must read «Додано 1 пункт до списку дій».

## Context

`createI18n` in `apps/ui/src/boot/i18n.ts` had no `pluralRules`. vue-i18n's built-in rule
(`pluralDefault` in `@intlify/core-base`) reads three forms as `zero | one | other`: n = 0 took
the first form, n = 1 the second, every n ≥ 2 the third. So «Додано 1 пункти…», «Додано 2
пунктів…», «Додано 0 пункт…». Affected uk messages: `management.chat.todoAdded`,
`riskExportSaved`, `riskExportPrinting`, the `{n} задача | {n} задачі | {n} задач` counter, and
`stateConnectedN`. The en catalog uses two forms only.

## Decisions

- `pluralRules: { uk }` with the standard East Slavic rule, applied only when a message has
  exactly three forms. Any other count (the two-form `notices.helper_added_instruction`) goes to
  the built-in rule that vue-i18n passes to a custom rule as `orgRule`, so its behaviour is
  unchanged. The rule uses `Math.abs` like the built-in one.
- Rejected: rewriting the messages into `zero | one | other` order (it cannot express 21 vs 25)
  and `Intl.PluralRules('uk')` (it has a fourth category, `other`, for fractions; the catalog has
  three forms).

## Changes

- `apps/ui/src/boot/i18n.ts`: `ukPluralRule`, passed as `pluralRules.uk`.
- `apps/ui/test/i18n-plural.spec.ts`: renders `management.chat.todoAdded` through the app's
  `i18n` instance for n = 0–5, 11–14, 19–25, 30, 31, 101, 102, 111, 112, and a two-form message
  for 0, 1, 2.

## Verification

- Before the fix (`boot/i18n.ts` stashed): 12 of 24 cases failed, e.g. n = 1 → «Додано 1 пункти
  до списку дій», n = 0 → «Додано 0 пункт…».
- After: `pnpm --filter @kermanych/ui exec vitest run` — 56 files, 615 tests passed.
  `vue-tsc --noEmit` reports only the known `test/runtime-messages.spec.ts` TS2352.
- Smoke in `quasar dev`: the app's `i18n` instance rendered n = 0, 1, 2, 5, 11, 21, 22, 25 as
  «пунктів, пункт, пункти, пунктів, пунктів, пункт, пункти, пунктів».

## Documentation impact

None — a rendering fix with no new command, config key or flow; the catalog's existing
`one | few | many` convention now renders as written.

## Out of scope

- `rejections.todo_item_kind_unknown` contains a literal `(check | number)` that vue-i18n parses
  as two plural forms and cuts at «(check»; reported as a separate finding.
