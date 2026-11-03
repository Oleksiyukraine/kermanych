# Risk Registry: owner and managers only

- **Date:** 2026-11-03
- **Branch:** `fix/restrict-risk-registry-developers`

## Goal

The operator asked that workspace members with the **developer** role:

- have no access to the Risk Registry page in Менеджмент;
- do not see the workspace's risks on the Менеджмент Home page — the Risk Registry tile must not
  be shown to them.

## Context

- The register (`workspace_risks`, `workspace_risk_events`) was member-level: the
  `*_member` RLS policies from `20260830140000_workspace_risks.sql` let any member read, insert
  and update. Only delete was owner-only (`20260904130000_risk_delete.sql`).
- The section is a row of `MANAGEMENT_SECTIONS` (`packages/core/src/management.ts`). The rail
  in `apps/ui/src/pages/ManagementPage.vue` and the routes in `apps/ui/src/router/routes.ts`
  are built from that table for everyone.
- Home (`apps/ui/src/pages/ManagementHomePage.vue`) renders every tile of the saved layout
  (`lib/dashboard.ts`), including `HomeRisksWidget`, which reads the risks store.
- The Менеджмент chat (`stores/management-chat.ts`) sends the register with every turn and
  carries out `risk.create/update/delete/export` under the caller's JWT.
- Roles: owner (`workspaces.owner_id`), manager and developer (`workspace_members.role`).
  `useProjects().canManageWorkspace` (owner or manager) already gates the password vault and
  needs the roster loaded.

## Decisions

- **Enforce in the database, not only in the UI.** New migration
  `20261103090000_workspace_risks_managers.sql`: function `can_access_workspace_risks(w, u)`
  (owner or manager) and policies `workspace_risks_{select,insert,update}_manager` and
  `workspace_risk_events_select_manager`, which replace the `*_member` ones. Hiding the screen
  alone would leave the rows readable through PostgREST.
  - Rejected: reusing `can_manage_workspace_passwords`. The answer is the same today, but these
    are two product decisions; a later change to the vault must not move the register.
  - Developers lose write access too. Filing a risk into a register you cannot read makes no
    sense, and `insert … returning` needs SELECT anyway.
  - Delete stays owner-only.
- **One flag in the section table.** `managersOnly: true` on the `management-risks` row. The
  rail and the route guard read it, so another section can be restricted later with one line.
- **Rail:** the row is hidden once the role is known to be developer. It is not hidden while
  the role is still loading, so a manager's rail does not flicker.
- **Route:** a manager-only route renders only when allowed. While the role is loading the pane
  shows a skeleton. A developer is redirected to Home with `router.replace`.
- **Home tile:** shown only once the role is known to allow it, so a developer never sees it
  flash in. It is filtered at render (`visibleTiles`), never removed from the saved layout, so
  a role regained brings the tile back where it was.
- **Chat:** for a developer the turn carries no risks, the Home digest lists no risks tile, and
  every `risk.*` action is refused with a stated reason instead of a raw RLS error.
- **Role loading:** `ManagementPage` loads the roster once per workspace.
  `useProjects().roleSettled` tells "still loading" apart from "known". A failed roster read
  counts as known and leaves the caller on the developer view, so nothing waits forever.

## Changes

- `kermanych/supabase/migrations/20261103090000_workspace_risks_managers.sql`: new.
- `packages/core/src/management.ts`: `ManagementSection.managersOnly`, set on `management-risks`.
- `apps/ui/src/stores/projects.ts`: `membersFailed`, `roleSettled()`; `canManageWorkspace`
  comment covers the register.
- `apps/ui/src/pages/ManagementPage.vue`: loads the roster, filters the rail, gates the
  `router-view`, redirects.
- `apps/ui/src/lib/dashboard.ts`: `visibleTiles()`.
- `apps/ui/src/pages/ManagementHomePage.vue`: renders `visibleTiles`. Arrow-key reorder steps
  over the tiles on screen only.
- `apps/ui/src/stores/management-chat.ts`: roster before register, register loaded and sent
  only to owner/manager, Home digest tiles filtered, `risk.*` refused for others.
- i18n `management.chat.riskManagersOnly` (en, uk).
- `packages/cloud/src/risks.ts`: header comments.
- Tests: `apps/ui/test/management-risks.spec.ts` gained a developer case; the projects-store
  mocks in four chat specs gained `canManageWorkspace`. `packages/cloud/test/rls.spec.ts` gained
  a «risk register» block (owner and manager file and read; developer reads nothing and
  cannot insert or update).

## Verification

- Migration on a throwaway Postgres 17: a minimal schema with the old policies, then the
  migration, then the same probes as owner, manager, developer and outsider.
  - Before: the developer read 3 risks and 4 events, inserted a row, and rewrote all 4 rows.
  - After: the developer read 0 risks and 0 events, the insert failed with `new row violates
    row-level security policy`, and the update matched 0 rows. Owner and manager could still
    read, insert and update; the manager's delete matched 0 rows (owner-only).
  - Applying the migration a second time succeeded.
- `pnpm --filter @kermanych/ui typecheck`: clean.
- Vitest: ui 794/794, core 261/261, cloud 168 passed (`rls.spec.ts` skipped — no local
  Supabase stack on this machine), api 1179/1179.
- Browser, in preview mode (preview api plus `quasar dev`), with the Supabase REST endpoints
  mocked so the roster puts the user in workspace «Acme»:
  - As developer: the rail has no Risk Registry, Home tiles are `capacity, tasks, releases,
    todo`, `/#/management/risk-registry` lands on `/#/management/home`, no `workspace_risks`
    request is made, and the console shows no errors.
  - As manager: the rail lists Risk Registry, Home includes the `risks` tile, and the register
    screen renders.

## Documentation impact

`kermanych/README.md`: new section «Who sees the risk register» (behaviour, the DB rule, and
the migration to push).
