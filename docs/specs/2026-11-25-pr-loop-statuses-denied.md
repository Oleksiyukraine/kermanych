# PR loop: a token that cannot read commit statuses

## Goal

The operator's session `feature/continue-creator-os-work` (project «Platinum OS - BE», PR
`Platinum-Commerce/plat-back-end#279`) had its PR merged into `dev`, yet the status line stayed on
`Задача ✓ → Агент ✓ → ПР ✓ → CI – → Ревʼю – → Злиття ○`, while the «Сесія» tab read
`PR #279 змерджено`.

## Context

- The «Сесія» tab gets `змерджено` from the merged-PR check (`SupervisorService.prCheck`), which
  reads only `GET /pulls/:n`.
- The status line gets CI, Ревʼю and Злиття from «Петля після ПР» (`PrLoopService.evaluate`),
  which also reads the head's check runs and combined commit status.
- The project's `GIT_TOKEN` is a fine-grained token that reads the PR, reviews and comments (200)
  but is refused both `commits/:sha/check-runs` and `commits/:sha/status` (403, rate limit not
  spent) — checked with `curl` against the PR's head `62676220`.
- A 403 on check runs was already tolerated (`checksDenied`); a 403 on commit statuses was not:
  it threw out of `evaluate`, `githubFailure` mapped it to `no_access`, and the loop published
  `unavailable: "no_access"` with no `pr`. The pipeline then shows CI and Ревʼю as «немає даних»
  and Злиття as ○, whatever GitHub says about the merge.

## Decisions

1. A non-rate-limited 403 on commit statuses is treated like the one on check runs: the source is
   skipped and `ci.checksDenied` is set. The PR, reviews and comments still read, so a merged PR
   reaches the status line as `pr.state: "merged"` (Ревʼю ✓, Злиття ✓).
   Rejected: feeding the merged-PR check's answer into the status line — it exists only for the
   selected session and only on the «Агенти» page, so the list cards would still disagree.
2. `checksDenied` keeps its name; its meaning widens to «a CI source was refused». Its message
   names both permissions.

## Changes

- `apps/api/src/pr-loop/pr-loop.service.ts` — `combinedStatus` goes through the same 403 guard as
  `checkRuns`; `checksDenied` is set when either is refused.
- `packages/core/src/pr-loop.ts` — `PrLoopCi.checksDenied` doc comment.
- i18n `uk` / `en` `prLoop.ci.checksDenied` — names «Checks: read» and «Commit statuses: read».
- `apps/api/test/pr-loop.spec.ts` — both CI sources refused, PR merged: not unavailable, merged,
  CI denied, loop ended.
- `apps/ui/test/status-line.spec.ts` — `in_review` with a merged PR and unreadable CI settles on
  Злиття ✓.
- `kermanych/README.md`, `docs/specs/2026-11-23-pr-feedback-loop.md` decision 11 — the statuses
  permission.

## Verification

- `vitest run test/pr-loop.spec.ts --maxWorkers=4` in `apps/api`: 16 passed.
- `vitest run test/status-line.spec.ts --maxWorkers=4` in `apps/ui`: 14 passed.
- `tsc --noEmit` in `apps/api`: clean.
- Not verified: the operator's running app — it runs the api from the main checkout, so the fix
  reaches PR #279's session only after this branch is merged and the app restarts (or the loop's
  next 2-minute tick after that).

## Documentation impact

`kermanych/README.md` «PR feedback loop» paragraph and decision 11 of
`docs/specs/2026-11-23-pr-feedback-loop.md`: a token without «Commit statuses: read» no longer
makes the loop unavailable.
