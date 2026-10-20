# In-place launch refusals: localized, with the paths in the way

## Goal

Operator report: unchecking «Ізолювати у worktree» and pressing «Запустити» ends in the raw
English line `project working tree must be clean to create an in-place (non-worktree) agent`.
The operator cannot tell what is dirty or what to do about it.

## Context

- `SupervisorService.resolveLaunchParams` (`apps/api/src/supervisor/supervisor.service.ts`)
  refuses an in-place launch on a dirty checkout, on a second live in-place agent, and on a
  detached HEAD. All three were plain `Error`s, so `sessionFailure` sent the English sentence
  and the launcher (`AgentsPage.vue` `launcherError`) showed it verbatim.
- The refusal itself is correct: the in-place agent runs `git checkout -b` in the project
  checkout, «Завершити» commits everything there (`commitAll`), and delete checks out the base
  with `-f`. Uncommitted work of the operator would be committed into the agent's branch or
  discarded.
- In the reported case the checkout really had uncommitted changes (two modified files, one
  untracked spec).

## Decisions

1. Keep all three guards. Allowing a dirty in-place launch was rejected: finish/delete would
   absorb or discard the operator's own changes.
2. Throw them as `CodedError`s — `inplace_tree_dirty`, `inplace_already_active`,
   `inplace_detached_head` — so the UI renders them in the operator's locale through the
   existing `ApiErrorBody` path. The Ukrainian sentence stays the fallback `message`.
3. `inplace_tree_dirty` names what is in the way: `params.count` (all paths) and
   `params.files` (the first five, comma-joined, `…` when cut). Every message names the way
   out, including turning the worktree isolation back on.

## Changes

- `packages/core/src/i18n-codes.ts`: three `ApiErrorCode`s.
- `apps/api/src/worktree/worktree.service.ts`: `uncommittedFiles(dir)` — paths from
  `git status --porcelain -z`; a rename/copy lists its new path.
- `apps/api/src/supervisor/supervisor.service.ts`: coded refusals; the file list is read only
  after `hasUncommitted` says the tree is dirty.
- `apps/ui/src/i18n/{uk,en}/index.ts`: `errors.inplace_*`.
- `apps/api/test/create-guards.spec.ts`: guards asserted by code; dirty-tree params (rename,
  untracked, the five-path cap).

## Verification

- `vitest run test/create-guards.spec.ts test/runtime-launch-error.spec.ts
  test/sessions.from-task.spec.ts` (api): 30 passed. `test/i18n-codes.spec.ts` (core): 5 passed.
- Full api suite: only `rpc-session.compact.spec.ts` fails (2), full ui suite: only
  `assignments.spec.ts` fails (1) — both fail identically without this change.
- `uncommittedFiles` on the reporter's checkout returned its three dirty paths; the uk/en
  catalogs render all three codes with those params through `localizeError`.

## Documentation impact

None beyond this document — the refusal conditions are unchanged; only their wording and
localization changed, and the launcher hint already says the tree must be clean.
