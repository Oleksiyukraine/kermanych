# План: перший запуск і візард проєкту

Специфікація: [`docs/specs/2026-11-18-first-run-and-project-wizard.md`](../specs/2026-11-18-first-run-and-project-wizard.md).

## Контракт (крок 0, спільний)

`kermanych/packages/core/src/git-setup.ts`: `GitInspect`, `GithubRepo`, `GitCloneState`,
`repoDirName`, `remoteIdentity`, `sameRemote`; подія `{ type: "git_clone"; state }` у
`ServerEvent` (`types.ts`).

Маршрути API:

| Маршрут | Тіло | Відповідь |
| --- | --- | --- |
| `POST /api/git/inspect` | `{ path }` | `GitInspect` |
| `POST /api/git/remote-head` | `{ url, token? }` | `{ defaultBranch: string \| null }` |
| `POST /api/git/clone` | `{ url, parentDir, dirName, token? }` | `GitCloneState` (`cloning`) |
| `GET /api/git/clone/:jobId` | — | `GitCloneState` |
| `POST /api/git/clone/:jobId/cancel` | — | `GitCloneState` |
| `POST /api/github/token-check` | `{ token }` | `{ login }`; 400 `token_invalid` |
| `POST /api/github/repos` | `{ token }` | `GithubRepo[]` |
| `PUT /api/projects/:id/env` (наявний) | + захист `.git/info/exclude` при `GIT_TOKEN` | `EnvFileView` |

## Кроки

1. [x] **Контракт у core.** Файли: `packages/core/src/git-setup.ts`, `index.ts`, `types.ts`.
   Перевірка: `pnpm --filter @kermanych/core build`.
2. [x] **API: git і GitHub.** Файли: `apps/api/src/git/git-setup.service.ts` (inspect,
   remote-head, clone-джоби з прогресом і скасуванням), `apps/api/src/git/git-credentials.ts`
   (credential helper за хостом; `worktree.service.ts#pushBranch` переходить на нього),
   `apps/api/src/http/git.controller.ts`, `apps/api/src/github/github-client.ts` (`user`,
   `repos`), `app.module.ts`, `env/env-file.service.ts` (exclude). Перевірка: vitest-спеки в
   `apps/api/test/` — розбір `--progress`, відмова для непорожньої теки, cancel прибирає лише
   створену теку, exclude ідемпотентний; `pnpm --filter @kermanych/api typecheck`.
3. [x] **UI: візард.** Файли: `apps/ui/src/components/onboarding/ProjectWizard.vue`,
   `apps/ui/src/lib/api.ts`, `i18n/{uk,en}/index.ts`. Перевірка: `vue-tsc`, превʼю.
4. [x] **UI: вітальний екран і вбудовування.** Файли:
   `components/onboarding/WelcomeScreen.vue`, `pages/AgentsPage.vue`, `layouts/MainLayout.vue`
   («+» → візард, «Швидке створення» → наявна модалка), `pages/BoardPage.vue` (перший «Запустити»
   неприв'язаного проєкту → візард «Підключити», далі запуск), `pages/SettingsPage.vue` (прив'язка →
   візард), `stores/onboarding.ts` і `OnboardingChecklist.vue` (без групи `connect`, без
   автовідкриття, підказки). Перевірка: `vue-tsc`, превʼю з порожнім реєстром, скриншоти станів.
5. [x] **Документація.** `kermanych/README.md`: «Start here», «Workspaces, projects and tasks»,
   «Cloud tasks and local sessions» (крок Bind), маршрути. Перевірка: читання.

## Ризики й порядок

- Крок 1 до 2–4; кроки 2 і 3–4 незалежні за контрактом.
- Міграцій немає: `color`, `default_branch`, `git_remote_url` у `projects` уже є.
- Username credential helper для GitLab/Bitbucket — `oauth2` / `x-token-auth` за хостом, інакше
  `x-access-token`; перевіряється на реальному репозиторії лише GitHub.
