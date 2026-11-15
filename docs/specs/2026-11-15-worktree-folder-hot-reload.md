# Session worktrees move to `.worktrees/`, so Next.js hot reload works

- **Branch:** `feature/fix-synergy-hot-reload`
- **Scope:** `packages/core` (`worktreeDir`), `apps/api` (worktree cleanup, startup GC), agent
  instructions, i18n `uk` / `en`, `kermanych/README.md`, `.gitignore`.

## Goal

The operator reported that in «Синергія» an edit the agent makes never shows in the live preview:
they have to reload the page or ask the agent to restart the preview after every request. The
feature exists to show each change in seconds (`docs/specs/2026-11-06-synergy.md`, decision 1:
«HMR shows it»), so the preview must pick up the agent's edits by itself.

## Context

- Every session worktree lives at `<repo>/.gitworktree/<branch>` (`worktreeDir` in
  `packages/core/src/worktree-names.ts`), and the preview runs the app from there.
- The failing session was a Next.js 15.5 app (`next dev`, webpack) in
  `grano/landing/.gitworktree/synergy/synergy-20261115-2313`. Its six requests carried six
  different preview ports: the preview was restarted between requests to see each change. The
  implementer that took the branch over hit the same thing: «The old markup is still being served»
  even after `location.reload()`, the dev server log showed one compile only, and it fell back to
  `preview_start {restart: true}`.
- Cause: Next's webpack `watchOptions.ignored`
  (`next/dist/build/webpack-config.js`, `baseWatchOptions`) is
  `/^((?:[^/]*(?:\/|$))*)(\.(git|next)|node_modules)(\/…)?/`. The segment after `.git` is
  optional and the pattern is not anchored at the end, so it matches any path with a segment that
  starts with `.git`: every file under `.gitworktree/` is ignored, and a Next app run from a
  session worktree never recompiles. Upstream: vercel/next.js#75372 (open).
- Vite (this repository's own UI) ignores `**/.git/**` only, so its HMR works from
  `.gitworktree/` (checked in this session's preview: `[vite] hot updated: /src/pages/SynergyPage.vue`).

## Decisions

1. **New session worktrees go to `<repo>/.worktrees/<branch>`.** A folder name that does not
   start with `.git` is the only fix Kermanych can make without editing the operator's projects.
   `.worktrees` is the name other tools already use for in-repo worktrees.
   - Rejected: telling each Next project to override `webpack.watchOptions.ignored` in
     `next.config` (every project, and the prototyping agent may not edit config). Rejected:
     running the preview through a symlinked path (Node resolves `process.cwd()` to the real
     path). Rejected: `WATCHPACK_POLLING` (polling still applies `ignored`).
2. **Existing sessions keep their stored paths in `.gitworktree/`.** Moving a live worktree would
   break its omp transcript folder, the running preview and any open terminal. A session started
   there keeps the old behaviour until it ends.
3. **Kermanych still recognises its trees in `.gitworktree/`.** The startup GC proves a tree is
   Kermanych's by its location (`worktreeDir(repo, branch)` of a session row), and deleting a
   session removes the empty prefix folders up to the worktrees folder. Both now check both
   folders, so trees left behind before the move are still swept and cleaned up.

## Changes

- `packages/core/src/worktree-names.ts`: `WORKTREE_FOLDERS = [".worktrees", ".gitworktree"]`
  (current first); `worktreeDir(repo, branch, folder = WORKTREE_FOLDERS[0])`.
- `apps/api/src/worktree/worktree.service.ts`: `dropEmptyParents` stops at either folder.
- `apps/api/src/gc/startup-gc.service.ts`: adoption looks for an interrupted launch's tree in
  either folder; the project sweep counts a tree as Kermanych's in either folder.
- `packages/core/src/skills.ts`: the agent's «Where you are» names `.worktrees/<branch>`.
- i18n `uk` / `en` (session id hints), `kermanych/README.md`, root `.gitignore` (`.worktrees/`
  added; `.gitworktree/` stays for older sessions and the release command's worktree).

## Verification

- **Root cause reproduced:** a two-file Next.js 15.5.15 app (`app/layout.tsx`, `app/page.tsx`,
  the grano landing's `node_modules`) run with `next dev` from `/tmp/…/.gitworktree/s` and from
  `/tmp/…/.worktrees/s`; after `MARK_ONE` → `MARK_TWO` in `page.tsx`, `curl /` returned
  `MARK_ONE` from `.gitworktree/s` and `MARK_TWO` from `.worktrees/s`.
- **Vite is unaffected:** this repository's own preview (`quasar dev`) from `.gitworktree/…`
  logged `[vite] hot updated: /src/pages/SynergyPage.vue` in the session browser after an edit.
- **Tests:** core 34 files / 491 tests (new: `worktreeDir` paths are not matched by Next's
  ignore pattern; the older folder by name); api 136 files / 1425 tests, 1 file / 4 skipped (new
  in `startup-gc.spec.ts`: a finished session's leftover in `.gitworktree/` is removed with its
  empty prefix folder); ui `assignments`, `i18n-completeness`, `i18n-plural` 48 tests; api
  `tsc --noEmit` clean.
- **Not verified:** a real «Синергія» session on a Next.js project in the desktop app after the
  change (needs a new session: the operator's current ones stay in `.gitworktree/`); Turbopack
  (`next dev --turbopack`) was not tried in either folder.

## Documentation impact

`kermanych/README.md`: worktree location (overview, startup GC, «Run»).
