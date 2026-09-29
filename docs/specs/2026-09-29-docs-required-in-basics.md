# «Обовʼязкова документація» → «Основне»

- **Date:** 2026-09-29
- **Branch:** `refactoring/perenesty-pole-obov-iazkova-dokumentatsi`

## Goal

Move the «Обовʼязкова документація» project setting from the «Git Налаштування» settings
pane to «Основне». The switch is a project-wide policy, not a git option, so operators look
for it among the project's basics.

## Context

`kermanych/apps/ui/src/pages/SettingsPage.vue` rendered the `KCheckbox` bound to
`draft.docsRequired` in the `project-git` pane, below the documentation-folders editor.
All project panes share one `ProjectDraft` and one save path (`saveProject` →
`projects.patch`), so the field's pane is presentation only.

## Decisions

- Place the checkbox in `project-basics` after «Git remote», inside the cloud-locked group
  (it keeps `:disabled="cloudLocked"`), and before the local-folder binding, which is per
  machine and not cloud-locked.
- Keep the i18n keys `settings.docs.required` / `settings.docs.requiredHint`: they are named
  for the subject (documentation), not the pane. Renaming them would be churn.
- «Теки з документацією» stays in «Git Налаштування»: the task names only the mandatory switch.

## Changes

- UI: `SettingsPage.vue` — checkbox block moved from the `project-git` pane to `project-basics`.
- i18n (`uk`, `en`): `settings.categories.project-basics.sub` / `.blurb` mention documentation.
- No API, data or migration change.

## Verification

- `pnpm --filter @kermanych/ui test` — 47 files, 533 tests passed.
- `pnpm --filter @kermanych/ui typecheck` — one error, in `test/runtime-messages.spec.ts`
  (TS2352), which this change does not touch; no error in the changed files.
- Preview-mode run (api with `KERMANYCH_PREVIEW=1 KERMANYCH_SEED=1` on a temp DB, ui with
  `VITE_KERMANYCH_PREVIEW=1`): «Основне» shows the checkbox with its hint between «Git
  remote» and the local folder; «Git Налаштування» no longer shows it; the sidebar sub
  «назва, колір, тека, документація» fits without overflow.

## Documentation impact

- `kermanych/README.md` «Mandatory documentation»: the switch is now in «Основне».
- `docs/specs/2026-09-28-mandatory-documentation-design.md` §3.1 UI: notes the new pane.
