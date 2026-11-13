# `/kermanych-release`: one command that ships a desktop release

- **Status:** Decisions agreed with the operator (deep-analysis interview, 2026-11-13);
  implementation pending approval.
- **Date:** 2026-11-13
- **Builds on:** `docs/specs/2026-10-12-desktop-releases-and-updates.md` (the release pipeline,
  `CHANGELOG.md`, the `release.yml` workflow, the update feed).

## Goal

A release takes one command. The operator opens a coding agent (omp, Claude Code) in the
repository root, types `/kermanych-release`, and the agent does the rest. It prepares the
version and the notes, asks once, publishes, and checks the published release. When something
breaks, it fixes what it is allowed to fix.

## Context

- A release today takes about a dozen manual steps (see the first release in the spec above):
  `pnpm release:prepare`, writing notes, a PR, merging, a tag, watching CI, downloading the
  artifacts, checking notarization and the native modules. Each step was a place to go wrong:
  a stale checkout, a stash in the way, a wrong account in `gh`, a retired runner image.
- The operator's checkout is `~/Documents/Projects/Multiagent-app`, the repository
  `Oleksiyukraine/kermanych`. `kermanych/` is a folder of it, not a repository of its own.
- The ambient `gh` there is signed in as `OleksiiGolf`, which can only read. The working token of
  `Oleksiyukraine` is `GIT_TOKEN` in `kermanych/.env`, where Kermanych keeps it. It must be passed
  inline to every `gh` call and HTTPS push. `git push` over the `origin` SSH remote works as is.
- `dev` is the default branch. It is not protected and has no rulesets.
- Command discovery: omp loads project commands from `<cwd>/.claude/commands/*.md` (its
  `claude` provider), and so does Claude Code. Both then offer `/kermanych-release`. A skill in
  `.claude/skills/<name>/SKILL.md` would be `/skill:kermanych-release` in omp. Neither looks in
  parent folders of `cwd`.
- No release is tagged yet. `dev` holds version `1.2.0` with its `CHANGELOG.md` section, and
  there is no `v1.2.0` tag.

## Decisions

1. **One stop, right before publishing.** The agent prepares everything without asking. Then it
   shows the proposed version, the release notes, the commits that go in, and the test results,
   and asks «Publish?». After «yes» it merges, tags, watches CI and checks the release. The tag
   is the step that reaches every user, so it is the step that needs the operator.
   - Rejected: a second stop before the tag (adds little after the first); no stop (the agent
     alone would pick what every user reads).

2. **Version and notes reach `dev` through a PR the agent merges itself.** The agent pushes
   `release/X.Y.Z` with one commit (the version in `apps/ui/package.json` and the `CHANGELOG.md`
   section), opens a PR into `dev`, merges it after the operator's «yes», and tags the merge
   commit `vX.Y.Z`. Every release leaves a PR behind: what went in and who started it.
   - Rejected: a direct commit to `dev` (no trace, and it races other merges); a PR the operator
     merges (that is a second stop).

3. **The agent proposes the version from the commits; the operator confirms it.** Since the last
   `v*` tag: any `feat` raises the minor, otherwise the patch. The agent never raises the major
   on its own. On `feat!:` or `BREAKING CHANGE` it says so at the stop and suggests the next major.
   - The operator can answer «yes» or «yes, but 1.4.0», or name the version up front:
     `/kermanych-release 1.4.0`.
   - Rejected: a version the operator always types; always +1 to the patch.

4. **The agent writes the notes for people, from the commits and the merged PRs.** It reads
   the commit subjects and the `## Summary` of the PRs merged since the last tag. It groups the
   notes as **New** (`feat`), **Improvements**, **Fixes** (`fix`). Each line says what changed
   for the user, not in the code. Internal work (`chore`, `docs`, `test`, CI, refactoring) stays
   out unless a user would notice it. The notes are in English (decision 10 of the base spec).
   The operator sees them at the stop and can ask for changes.
   - Rejected: the in-app «Реліз-ноти» generator (not reachable from a terminal agent); the raw
     commit list (noise for users).

5. **After «yes» the agent fixes failures itself, code included, through PRs, a merge and a new
   tag.** Within the safeguards of decision 6.
   - Rejected: fixing only transient failures and handing the rest to the operator; reporting only.

6. **Safeguards on decision 5.**
   - **A broken published release is hidden first.** When a check fails after publishing, the
     agent's first action is `gh release edit vX.Y.Z --draft`. The updater and new users no
     longer see it, and the files stay. The fix ships as the next patch version. A published
     version is never overwritten.
   - **Fixes stay within the release.** The agent may fix what stopped the release: the build,
     the workflow, the packaging config, tests. It does not change product behaviour without the
     operator. When the cause is there, it stops and reports.
   - **Checks pass before every re-tag:** the typecheck and the tests of the packages the fix
     touched.
   - **At most two fix attempts.** After two fix PRs without a release, the agent stops and
     reports.
   - A failed CI job whose cause is outside the code (runner queue, network, a notarization
     timeout) is re-run once on the same commit before anything else.
   - A tag whose run created no release is deleted before a re-tag. Nothing was published, so
     nothing breaks.
   - After every fix the agent reports what it changed, why, and the PR.

7. **After publishing, automatic checks only. There is no manual checklist for the operator.**
   - **GitHub Release:** `Latest`; the seven assets (`.dmg`, `.zip`, `.AppImage`, the dmg's and
     the zip's `.blockmap`, `latest-mac.yml`, `latest-linux.yml`); the body equal to the `CHANGELOG.md` section;
     the new version in both `latest-*.yml`.
   - **mac:** the dmg and the zip are downloaded and given the quarantine attribute. The app
     inside: `spctl` «Notarized Developer ID», `stapler validate`, `syspolicy_check distribution`
     «ready for distribution», `CFBundleShortVersionString` = the version, `app-update.yml` →
     `Oleksiyukraine/kermanych`.
   - **linux:** the AppImage's squashfs is unpacked in Docker. `node-pty/build/Release/pty.node`
     and `better-sqlite3/prebuilds/linux-x64.node` must be present, ELF x86-64, needing no newer
     glibc than 2.34.
   - Rejected: adding a checklist of manual checks; checking only the asset list.

8. **Typecheck and all tests run before the stop.** The agent runs them on the exact commit that
   will be released: `vue-tsc` in `apps/ui` and the test suites of `packages/core`,
   `packages/cloud`, `apps/api` and `apps/ui`, at most 4 workers. A failure means no stop and no
   release: the agent reports what failed.
   - Rejected: relying on CI, which does not test; comparing against the previous tag to ignore
     failures that are already on `dev` (twice the time).

## Behaviour

What the command does, in order. The command file is the agent's instructions; this section is
its contract.

**Where.** The command lives in `.claude/commands/kermanych-release.md` at the repository root.
Run the agent from `Multiagent-app`, not from `kermanych/`.

**Preconditions.** If any of these fails, the agent stops before changing anything and says
which one:
- the repository is `Oleksiyukraine/kermanych`, and `GIT_TOKEN` from `kermanych/.env` acts as a
  user with push rights (`gh api user`, `gh api repos/…` → `push: true`);
- no `release.yml` run is in progress;
- the version has no tag and no GitHub Release yet;
- something releasable has landed since the last tag. With no tag at all, the version on `dev`
  is the one to release: `1.2.0`, whose section already exists.

**The operator's checkout is never touched.** The agent fetches `origin` and works in a
temporary worktree on `origin/dev` under `.gitworktree/release-X.Y.Z` (that path is gitignored).
It removes the worktree at the end. A dirty checkout, a stash or a different branch in
`Multiagent-app` does not matter.

**Preparing.** In the worktree the agent:
1. installs dependencies (`pnpm install --frozen-lockfile`);
2. reads the commits and PRs since the last tag and proposes the version (decision 3);
3. writes the notes (decision 4);
4. bumps `apps/ui/package.json` and adds the `CHANGELOG.md` section (`pnpm release:prepare`,
   then the notes), and checks them with `pnpm release:notes X.Y.Z`;
5. runs the checks (decision 8);
6. pushes `release/X.Y.Z` and opens the PR.

When the version is already on `dev` with its section and has no tag (the first release, or a
PR merged by hand), steps 2–4 and the PR are skipped, and that version is offered as is.

**The stop.** The agent shows the version and why, the notes, the PR, the commits that go in and
the test results, and waits for the operator's answer.

**Publishing.** The agent merges the PR, tags the merge commit `vX.Y.Z` and pushes the tag. It
watches the run until it completes. Then it runs the checks of decision 7, fixing failures
within decision 6.

**The report.** The release link and the result of each check. For each fix: what it changed,
why, and the PR. Anything left open. The agent uses the operator's language.

## Changes

- `.claude/commands/kermanych-release.md` (new): the agent's instructions, following
  **Behaviour**.
- `kermanych/README.md` → «Releasing a version»: run `/kermanych-release` from the repository
  root. The manual steps stay below it as what the command does and as the fallback.
- `docs/specs/2026-10-12-desktop-releases-and-updates.md`: a pointer to this spec under the
  release procedure.

## Verification

- Discovery: omp started in the repository root lists `/kermanych-release`.
- A dry run of the preparation (everything up to the stop, answer «no»): the version and the
  notes are proposed, tests run, the PR opens. «No» leaves no tag; the agent closes the PR and
  deletes the branch.
- The first real use is the `v1.2.0` release still pending on `dev`. It runs the whole path:
  the stop, the merge-less path for an already-prepared version, the tag, CI, and every check of
  decision 7.
