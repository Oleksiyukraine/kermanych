# Agentic maturity report: quick wins on the Kermanych side

## Goal

The second-pass maturity review of Platinum OS with the Kermanych harness (Agentic Engineering
Maturity — Factory Edition 2026.06.0, 2026-11-26) lists the gaps that keep the overall stage at S1.
Most live in the product repos and GitHub (CI gates, CODEOWNERS, secret scanning, IP policy). This
change closes the ones that sit in Kermanych and fit in one small change:

| Report item | Gap | Here |
| --- | --- | --- |
| 4.8 Checklist names AI-specific risks | Ревізор's instruction names none | Ревізор audits the typical AI failures by name |
| 4.5 Test-diff scrutiny | — | Ревізор is told to read test changes for weakened assertions |
| 4.7 Small-PR rule | only Посіпака has one | «Створити ПР» warns about a large PR in its body |
| 6.4 MCP vetted and pinned | catalog adds `npx …@latest` | catalog pins exact versions |

## Context

- Ревізор's default instruction (`packages/core/src/agents.ts`, `REVIEW`) asked for a "full audit"
  with no AI-specific failure modes.
- «Створити ПР» (`SupervisorService.createPullRequest`) appends Kermanych's own blocks after the
  «Провізор» instruction — base sync, the minion title rule, the QA checklist directive, the
  reflection step. Nothing looked at the size of the change.
- The MCP catalog (`apps/ui/src/lib/mcp-catalog.ts`, `docs/specs/2026-11-16-mcp-catalog.md`
  decision 9) added Playwright and Chrome DevTools as `npx -y <pkg>@latest` and Brave Search with
  no version at all.

## Decisions

1. **Ревізор names six AI failure modes** in its default text: hallucinated imports/APIs/flags,
   weakened tests, shallow tests, duplication of existing helpers, untrusted input reaching a sink,
   secrets. A project that overrode the instruction keeps its own text. *Rejected:* a separate
   appended block like the base sync — the review instruction is the audit itself, and an operator
   who rewrote it chose what to audit.
2. **The PR size is measured by the api, not by the model**: `WorktreeService.changedFiles` from the
   branch's fork point, committed and uncommitted — the listing the «Завершити» sheet shows.
   Lockfiles are left out. Over 400 changed lines (added + removed) the prompt gets
   `prSizeBlock`: the numbers and a request for a `## Size` section with a split proposal. Under the
   limit nothing is appended.
3. **A warning, not a refusal.** The PR still opens: a large change can be right, the reviewer just
   has to know. A listing that fails drops the warning and logs, never blocks the PR.
   *Rejected:* making the agent split the branch — that rewrites work the operator already
   approved, and a split needs judgment.
4. **Appended after the instruction**, like the base sync, so an overridden «Провізор» still carries
   it. Only «Створити ПР»; «Закоміти» updates a PR that already exists.
5. **Local catalog servers name an exact version.** The `npx` helper takes the version as a required
   argument, and a test fails on any stdio entry without `@x.y.z`. Versions at the time of writing:
   `@playwright/mcp@0.0.86`, `chrome-devtools-mcp@1.14.0`, `@brave/brave-search-mcp-server@2.2.0`.
   Servers already saved in a project's `.mcp.json` are the operator's and are not touched.
   *Rejected:* a lockfile-style pin by integrity hash — `npx` has no flag for it.

Replaces: decision 9's `npx` rows of `docs/specs/2026-11-16-mcp-catalog.md` (now pinned).

### Not done here, and why

- **6.2 secret scanning before push.** An api-side scan only covers pushes from «Створити ПР» /
  «Закоміти»; agents push in other turns too, a found secret in an already-made commit needs a
  history rewrite that Kermanych forbids, and false positives need an override. Needs its own design.
- **4.1 Ревізор on high-risk paths.** Triggers today match keywords in the request, not changed paths.
- **9.5 budgets and alerts, 3.6 parallelism tied to reviewers.** Features, not quick fixes.
- Repo / GitHub items (CI as a wall, CODEOWNERS, gitleaks, FE `.claude/settings.json`, IP policy)
  belong to the Platinum repos.

## Changes

- `packages/core/src/agents.ts`: `REVIEW` text; `PR_SIZE_LIMIT_LINES`, `prSizeBlock` (exported).
- `apps/api/src/supervisor/supervisor.service.ts`: `prSizeRule`; `createPullRequest` appends it after
  the minion title rule.
- `apps/ui/src/lib/mcp-catalog.ts`: `npx(pkg, version, args, env)`; three entries pinned.
  `McpServerEditor.vue`: the args placeholder no longer shows `@latest`.
- i18n `agent-about` (uk, en): «Провізор»'s "adds" mentions the size warning.
- Tests: `apps/api/test/agent-instructions.spec.ts` (review text),
  `apps/api/test/supervisor.pr.spec.ts` (size warning on/off, lockfiles, failed listing),
  `apps/ui/test/mcp.spec.ts` (every local entry pinned).

## Verification

- `packages/core`: `tsc -p tsconfig.json`; `vitest run test/agents.spec.ts` — 14 passed.
- `apps/api`: `vitest run test/agent-instructions.spec.ts test/supervisor.pr.spec.ts
  test/minion.spec.ts test/base-sync.spec.ts test/supervisor.docs-gate.spec.ts test/tester.spec.ts`
  — 6 files, 93 passed; `tsc --noEmit` clean.
- `apps/ui`: `vitest run test/mcp.spec.ts` — 13 passed; `vue-tsc --noEmit` clean.

Not verified: a live «Створити ПР» run on a real large branch (the prompt is checked in tests, the
agent's handling of `## Size` is not); the pinned MCP versions were read from npm on 2026-11-26 but
not launched.

## Documentation impact

- `kermanych/README.md`: «Size warning» paragraph after «Base sync»; the catalog bullet says local
  entries are pinned.
- `docs/specs/2026-11-16-mcp-catalog.md` decision 9 superseded for the `npx` rows (see Replaces).
