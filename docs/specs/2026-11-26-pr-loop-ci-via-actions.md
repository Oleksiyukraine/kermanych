# PR loop: CI of a fine-grained token through the Actions API

## Goal

The operator's session `feature/creators-completion-frontend` (project plat-front-end, PR
`Platinum-Commerce/plat-front-end#295`) showed CI as «немає даних» with the tooltip «дайте йому
право «Checks: read»». GitHub's fine-grained token form has no «Checks» permission at all
(community discussions #129512, #179545), so the advice could not be followed and CI could never be
read with such a token.

## Context

- The project's `GIT_TOKEN` (fine-grained, account `OleksiiAttaima`), checked with `curl` against
  the PR's head `1b701bf`: `commits/:sha/check-runs` 403; `commits/:sha/status` 200 (0 statuses);
  `actions/runs?head_sha=` 200 (workflow `CI`, completed/success); `actions/runs/:id/jobs` 200
  (jobs `build`, `verify`, each with `html_url` `…/actions/runs/<run>/job/<job>`).
- GraphQL `statusCheckRollup` gives the overall state, but its `CheckRun` contexts are refused
  the same way — no job names or URLs for a round.
- For GitHub Actions a check run is a job: same name, status, conclusion and `html_url`.

## Decisions

1. When the check runs answer 403 (not a spent rate limit), the loop reads the head's GitHub
   Actions jobs instead: `GET /actions/runs?head_sha=` and, per workflow run,
   `GET /actions/runs/{id}/jobs?filter=latest`. Jobs go through the same mapping as check runs, so
   failures reach the agent with the job URL its prompt expects. A workflow run with no job yet
   (queued) stands for itself as a pending check.
   Rejected: GraphQL `statusCheckRollup` (state only, contexts refused); telling the operator to
   use a classic token (organisations often block them, and it widens the token's reach).
2. The fallback is read only after the check runs are refused: a token that reads them costs no
   extra requests.
3. CI read this way carries `ci.checksVia: "actions"`, not `checksDenied`: the CI stage shows the
   real result, the PR can be «готово до мерджу», and the tooltip says checks of other GitHub Apps
   are not seen. Branch protection still gates the merge on GitHub.
   Rejected: keeping `checksDenied` (and blocking «готово до мерджу») — the common case, a repo
   whose CI is GitHub Actions, would never look ready.
4. `checksDenied` now means «a CI source with no substitute was refused»: check runs and Actions
   both (no «Actions: read»), or the commit statuses. Its message names «Actions: read» and
   «Commit statuses: read» and says a fine-grained token has no «Checks».
5. The project wizard's token rights drop «Checks»: Actions and Commit statuses read.

## Changes

- `kermanych/apps/api/src/github/github-client.ts` — `GithubClient.actionsJobs`.
- `kermanych/apps/api/src/pr-loop/pr-loop.service.ts` — the fallback, `checksVia`.
- `kermanych/packages/core/src/pr-loop.ts` — `PrLoopCi.checksVia`, `checksDenied` doc comment.
- `kermanych/apps/ui/src/lib/status-line.ts`, `components/kit/KStatusLine.vue` — the
  `prLoop.ci.viaActions` tip and popover row.
- i18n `uk` / `en`: `prLoop.ci.checksDenied`, `prLoop.ci.viaActions`, the wizard's `rights`.
- `kermanych/apps/api/test/pr-loop.spec.ts`, `kermanych/apps/ui/test/status-line.spec.ts`.
- `kermanych/README.md`, decision 11 of `docs/specs/2026-11-23-pr-feedback-loop.md`.

## Verification

- `vitest run test/pr-loop.spec.ts --maxWorkers=4` in `apps/api`: 17 passed (refused check runs
  read as Actions jobs, a failed job sent to the agent with its URL; check runs and Actions both
  refused → `checksDenied`).
- `vitest run test/status-line.spec.ts --maxWorkers=4` in `apps/ui`: 15 passed.
- `tsc --noEmit` in `apps/api`, `vue-tsc --noEmit` in `apps/ui`: clean (apart from the unbuilt
  `@kermanych/api` in `src-electron`, unrelated).
- `GithubClient.actionsJobs` against PR #295 with the project's token: check runs 403, jobs
  `build` and `verify` returned, completed/success.
- Not verified: the operator's running app — it runs the api from the main checkout, so the fix
  reaches the session after this branch is merged and the app restarts.

## Documentation impact

`kermanych/README.md` (wizard token rights; «PR feedback loop» paragraph) and decision 11 of
`docs/specs/2026-11-23-pr-feedback-loop.md`.
