# Branch name generated from the task, not transliterated

## Goal

Card «Зробити автоматичне генерування назви гілки з контексту задачі»: an agent's branch name
should say what the task is about, not be the card title transliterated letter by letter.

Today the card «Зробити автоматичне генерування назви гілки з контексту задачі» becomes
`feature/zrobyty-avtomatychne-heneruvannia-nazvy-`: Ukrainian transliterated to Latin and cut
at 40 characters in the middle of a word.

## Context

- `SupervisorService.resolveLaunchParams` (`apps/api/src/supervisor/supervisor.service.ts`) names
  the branch of every new agent: `uniqueSlug(branchName(slugify(name), prefix), existing)`.
  Three paths reach it: a card launch (`launchTask`, the operator's ▶ and «Посіпака»), a chat
  promoted to an agent (`promoteChatToAgent`), and a reopened session whose branch is gone
  (`reopenSession`).
- `slugify` (`packages/core/src/worktree-names.ts`) lowercases, transliterates Cyrillic, keeps
  `[a-z0-9]`, joins with `-` and slices at 40 characters.
- The launcher (`apps/ui/src/pages/AgentsPage.vue`) previews the branch with the same
  `slugify` on the name field.
- The API already asks a model single questions through `runOneShot`
  (`apps/api/src/runtime/one-shot.ts`): release notes and the Slack bot.

## Decisions

1. **A one-shot model call names the branch.** `BranchNameService.suggest` sends the task's
   title and description (description capped at 4000 characters) to a tool-less one-shot child
   and asks for a short English kebab-case slug of 2–5 words. The prefix (`feature`, `fix`, …)
   stays the card's; the model writes only the part after the slash.
2. **The cheap model of the operator's own runtime.** omp gets `pi/smol` (the operator's
   configured smol role, whatever the provider); claude-code gets `haiku`. The runtime is the
   operator's managed-runtime preference (`resolveRuntime`), as for release notes and Slack.
   The child runs in the home directory with no tools: it needs no repository.
3. **Bounded, and never a reason to refuse a launch.** The call is bounded at 15 s for the
   start and 15 s for the answer (new optional `startTimeoutMs` / `turnTimeoutMs` on
   `runOneShot`). A timeout, a missing runtime, a model error or an answer with no usable slug
   is logged and the branch falls back to the transliterated title, as before.
4. **The model's answer is sanitised, not trusted.** `modelBranchSlug` takes the first
   non-empty line, drops backticks and quotes, drops anything up to the last `/` (a model that
   writes `feature/…` anyway), then runs it through `slugify`. A result without a letter or a
   digit counts as no answer.
5. **`slugify` cuts at a word boundary.** Both the model's slug and the fallback are capped at
   40 characters; the cap now drops the partial last word instead of leaving `nazvy-`.
   A single word longer than 40 is still sliced.
6. **The naming runs after the in-place guards.** A refused launch (dirty tree, second
   in-place agent, detached HEAD) answers at once and spends no model call.
7. **The launcher no longer predicts the slug.** It cannot know the model's answer before the
   launch, so the branch box shows `<prefix>/…` and the hint says the name is generated from
   the task at launch. Rejected: a preview endpoint that calls the model while the operator
   types — a model call per keystroke pause for a label.
8. **The service is optional in the supervisor**, like the browser and machine services: specs
   that construct `SupervisorService` without it keep the transliterated name and spawn nothing.
   Rejected: storing a generated name on the cloud card — a migration for a value only the
   launching machine needs.

## Changes

- `packages/core/src/worktree-names.ts`: `slugify` cuts at a word boundary.
- `apps/api/src/runtime/one-shot.ts`: optional `startTimeoutMs`, `turnTimeoutMs`; imports
  `limit` from its new home.
- `apps/api/src/runtime/limit.ts` (new): `limit`, moved out of `management-chat.service.ts`.
  The supervisor now reaches `one-shot.ts`, and `one-shot.ts` importing the management chat
  closed a cycle (chat → management MCP → Jira tools → `JiraService` → supervisor) that left
  `JiraService`'s constructor types undefined: the api refused to boot. Same body, now on
  `Promise.withResolvers`.
- `apps/api/src/supervisor/branch-name.service.ts` (new): `BranchNameService.suggest`, the
  prompt, `modelBranchSlug`.
- `apps/api/src/supervisor/supervisor.service.ts`: `resolveLaunchParams` takes the task's title
  and description and names the branch through the service; the three callers pass them.
- `apps/api/src/app.module.ts`: registers `BranchNameService`.
- `apps/ui/src/pages/AgentsPage.vue`, `apps/ui/src/i18n/{uk,en}/index.ts`: the launcher shows
  `<prefix>/…` and the new hint.
- Tests: `packages/core/test/worktree-names.spec.ts` (word-boundary cut),
  `apps/api/test/branch-name.spec.ts` (sanitising, fallback, model and runtime choice),
  `apps/api/test/sessions.from-task.spec.ts` (a card launch names its branch from the task).
- `kermanych/README.md` «Cloud tasks and local sessions» → «Run»: how the branch is named.

## Verification

- `pnpm typecheck` in `apps/api`: clean. `pnpm typecheck` in `apps/ui`: only the existing
  `test/runtime-messages.spec.ts` TS2352, in a file this change does not touch.
- Full suites, 4 workers: api 115 files / 1079 tests passed (4 skipped), core 23 / 230,
  ui 63 / 717.
- A throwaway spec ran the real `BranchNameService` on this card's own title and description:
  omp → `auto-generate-branch-name-from-task` in 2.5 s, claude-code →
  `auto-generate-branch-name-from-context` in 6.8 s. Removed after the run.
- The built api booted with `KERMANYCH_PREVIEW=1` (DI resolves `BranchNameService`; before the
  `limit` move it failed on `JiraService`). The preview UI's «Нова задача» shows
  «назву гілки складе модель із задачі під час запуску» under the name and `fix/…` in the
  branch box after picking `fix`.

## Documentation impact

`kermanych/README.md`, «Cloud tasks and local sessions», step «Run»: the branch name is
generated from the task by the runtime's fast model, with the transliterated title as the
fallback.
