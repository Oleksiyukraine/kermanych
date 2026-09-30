# File manager: project files without a session

## Goal

The file-manager dock (⌘B / the ◧ ◨ footer toggles) only shows something once an agent
session is selected — then it lists that session's worktree. The operator also wants to
browse files when not working with agents:

- a session is selected → show the session's worktree (unchanged);
- no session is selected → show the selected project's own checkout (`localRepoPath`).

## Context

- `apps/ui/src/components/kit/KFileManager.vue` reads `store.selectedSessionId` and calls
  `store.sessionTree` / `store.sessionFile` (`GET /sessions/:id/tree`, `/sessions/:id/file`).
  With no session it shows «Оберіть сесію…».
- `SupervisorService.sessionTree/sessionFile` resolve the directory (worktree, or the project
  repo for an in-place session) and delegate to `WorktreeService.listTree/readFileContent`,
  which own the `..`/absolute path guard.
- A project's checkout on this machine is `Project.localRepoPath` (`""` when unbound);
  `boundProject()` throws `project not bound` for an unbound one.

## Decisions

- New project-scoped reads `GET /projects/:id/tree?path=` and `GET /projects/:id/file?path=`
  over `localRepoPath`, reusing `listTree`/`readFileContent` so the path guard and the
  binary/oversize flags are the same as for a session. Rejected: reusing `/docs/tree` — it is
  restricted to published doc folders on purpose.
- Source selection is purely UI-side: session wins when one is selected, else the selected
  project. No new store state; the dock follows the existing selection.
- Empty states mirror the terminal panel: no project → «Оберіть проєкт або сесію»; project not
  bound → a notice instead of an API error.

## Changes

- API: `SupervisorService.projectTree/projectFile`; `ProjectsController` routes `:id/tree`,
  `:id/file`.
- UI: `api.projectTree/projectFile`, store wrappers; `KFileManager` resolves a source
  (session worktree or project checkout), header shows the branch / project name.
- i18n (uk, en): `fileManager.noSession` → `fileManager.noSelection`, new `fileManager.notBound`.

## Verification

- `pnpm --filter @kermanych/api typecheck` — clean; `vitest run test/file-tree.spec.ts` — 7 passed.
- `pnpm --filter @kermanych/ui test` — 47 files / 533 tests passed (incl. i18n key parity).
  `vue-tsc` reports only pre-existing errors outside this change (`src-electron/electron-main.ts`
  needs the api build, `test/runtime-messages.spec.ts` cast).
- Throwaway supervisor smoke (real `WorktreeService`, temp checkout, removed afterwards):
  `projectTree("p1","")` → `src/`, `README.md` (`.git` hidden); `projectTree("p1","src")` →
  `a.ts`; `projectFile("p1","src/a.ts")` → body; unbound → `project not bound`; `../..` →
  `invalid path`; unknown id → `project not found`.
- The dock itself was not exercised in a browser: the UI needs a signed-in cloud session and
  a running api over the operator's real registry.

## Documentation impact

None — no living doc describes the file-manager dock or the session tree routes; the
behaviour is captured in this spec and the in-app empty-state copy.
