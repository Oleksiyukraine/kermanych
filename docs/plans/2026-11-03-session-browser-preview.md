# Plan: session browser and live preview as one, preview file, project platform

Task document: `docs/specs/2026-11-03-session-browser-preview.md`. Paths below are relative to
`kermanych/` unless they start with `docs/`.

## Order and risks

- **Contracts first**, so that the three slices can run in parallel against them:
  - `packages/core` (`platform.ts`, `preview.ts`, `types.ts`);
  - `apps/api/src/browser/browser-host.ts` (`openPreview`, `isPaused`).
- **Ship the migration together with the client that stops reading the dropped columns.** Older
  builds break on it (accepted, decision 10).
- **Local SQLite columns stay unused, and no `DROP` is issued.**

## Steps

1. **Contracts.** [x]
   - Files: `packages/core/src/{platform,preview,types,index}.ts`,
     `apps/api/src/browser/browser-host.ts`.
   - Check: `tsc --noEmit` (core), plus a throwaway parser smoke run.
2. **API slice** (preview service, endpoints, lifecycle, MCP tools, gates, project platform in
   registry and supervisor, the `preview-config` skill). [x]
   - Files: `apps/api/src/{preview,http,supervisor,browser,registry}/…`,
     `packages/core/src/skills.ts`, `apps/api/test/*`.
   - Check: `apps/api` `tsc --noEmit`, `vitest run`.
3. **Cloud and platform slice** (migration, `packages/cloud`, management action and prompt, the UI
   of the task platform removal and the project platform field). [x] The RLS/trigger suite was
   not run: Docker is not running on this machine.
   - Files:
     - `supabase/migrations/20261103100000_project_platform.sql`;
     - `packages/cloud/src/{projects,tasks,types}.ts`;
     - `packages/core/src/{management-actions,i18n-codes}.ts`;
     - `apps/api/src/management/management-prompt.ts`;
     - `apps/ui/src/{pages/BoardPage.vue,pages/SettingsPage.vue,layouts/MainLayout.vue,lib/tasks-view.ts,lib/publish-backlog.ts,lib/settings.ts,stores/{board,projects,management-chat}.ts}`;
     - the launcher parts of `pages/AgentsPage.vue`;
     - i18n.
   - Check: cloud `vitest`, the RLS/trigger suite when the local stack is up, ui `vue-tsc`.
4. **UI slice** (the preview row, the logs panel, the empty states, tab gating and status, the web
   build tab, the store, the api client, Electron `openPreview` / `isPaused` / preview origin). [x]
   - Files:
     - `apps/ui/src/components/kit/KBrowserPane.vue`;
     - the preview parts of `pages/AgentsPage.vue`;
     - `stores/{orchestrator,browser}.ts`, `lib/api.ts`;
     - `src-electron/session-browser/*`, `electron-preload.ts`, `types/kermanych-bridge.d.ts`;
     - i18n.
   - Check: ui `vue-tsc`, `vitest`.
5. **Kermanych's own `.kermanych/preview.json` and the README.** [x]
   - Files: `.kermanych/preview.json` (repo root), `README.md`.
   - Check: Kermanych previews itself in the dev app.
6. **Integration.** [x]
   - Full `tsc` / `vue-tsc` / `vitest` (≤ 4 workers, one run at a time).
   - The Electron dev app smoke described in the task document's Verification.
