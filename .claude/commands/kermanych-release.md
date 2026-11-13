---
description: Ship a Kermanych desktop release — version, notes, tests, one confirmation, tag, CI, checks
argument-hint: "[version, e.g. 1.4.0]"
---

# Ship a Kermanych desktop release

The operator typed `/kermanych-release` with these arguments: `$ARGUMENTS`. An argument is a
version (`1.4.0`) that overrides your proposal. No argument means you propose the version.

You do the whole release yourself. You stop **once**, right before publishing, and wait for the
operator's answer. Spec, with the reasons behind every rule below:
`docs/specs/2026-11-13-kermanych-release-command.md`. The release pipeline itself:
`docs/specs/2026-10-12-desktop-releases-and-updates.md`. Report to the operator in their language.
Commit messages, branch names and release notes are in English.

## Ground rules

- **Run from the repository root.** `git rev-parse --show-toplevel` must equal the current
  directory, and `git remote get-url origin` must point at `Oleksiyukraine/kermanych`. Otherwise
  stop and say so. `kermanych/` is a folder of this repository, not a repository of its own.
- **Credentials.** The ambient `gh` may be signed in as an account that can only read. Every `gh`
  call gets the project token inline, read fresh in the same command (each shell is new). Never
  print the token.
  ```bash
  GH_TOKEN="$(grep -E '^GIT_TOKEN=' kermanych/.env | head -n1 | cut -d= -f2-)" gh <args> -R Oleksiyukraine/kermanych
  ```
  Use `git push origin …` as is: `origin` is an SSH remote and does not need the token. Run the
  `gh` calls from the repository root, because `kermanych/.env` is gitignored and exists only in
  the operator's checkout.
- **Never touch the operator's checkout.** No checkout, stash, reset, commit or pull in it. A dirty
  tree, a stash or another branch there is not your concern. All work happens in a temporary
  worktree: `git fetch origin dev --tags`, then `git worktree add .gitworktree/release-<version>
  …` (`.gitworktree/` is gitignored). Remove the worktree at the end, whatever the outcome.
- **The only stop is the publish question.** Do not ask anything else along the way. If a
  precondition fails, stop and report. Do not ask how to proceed.
- Run test runners with at most 4 workers, one run at a time.

## 1. Preconditions

Stop before changing anything, and name the failed check, if any of these is not true:

1. The token acts as a user who can push: `gh api user --jq .login` answers, and
   `gh api repos/Oleksiyukraine/kermanych --jq .permissions.push` is `true`.
2. No `release.yml` run is in progress: `gh run list --workflow release.yml --status in_progress`
   and `--status queued` are both empty.
3. Find the last release tag: `git describe --tags --abbrev=0 --match 'v*' origin/dev`. No tag at
   all means this is the first release.
4. Something is releasable:
   - **Prepared version.** If the version in `kermanych/apps/ui/package.json` on `origin/dev` has
     no `v<version>` tag and `CHANGELOG.md` on `origin/dev` has a non-empty section for it (check
     with `pnpm -s release:notes <version>` in the worktree), that version is the one to release
     as is. Skip step 2 (no version bump, no PR), unless an argument names a different version.
   - **New version.** Otherwise `git log --no-merges --format='%h %s' <last tag>..origin/dev` must
     list at least one commit. With none, there is nothing to release: say so and stop.
5. The chosen version has no tag (`git ls-remote --tags origin v<version>` is empty) and no GitHub
   Release (`gh release view v<version>` fails).

## 2. Prepare (new version)

1. Create the worktree on a new branch: `git worktree add -b release/<version> .gitworktree/release-<version> origin/dev`.
   Inside it, in `kermanych/`, run `pnpm install --frozen-lockfile`.
2. **Version.** Read the commit subjects since the last tag (Conventional Commits). With any
   `feat`, raise the minor (`1.2.0` → `1.3.0`). Otherwise raise the patch (`1.2.0` → `1.2.1`).
   Never raise the major yourself. If a commit is `feat!:`, `fix!:` or mentions `BREAKING CHANGE`,
   keep the minor/patch proposal and flag the breaking change at the stop, suggesting the next
   major. An argument overrides all of this; it must be valid semver and higher than the current
   version.
3. **Notes.** Read the subjects and the merged PRs since the last tag:
   `gh pr list --state merged --base dev --limit 200 --json number,title,body,mergedAt`, keeping
   the ones merged after the last tag's commit date. Use each PR's `## Summary`. Write the
   section for people who use the app:
   - Group the lines under `### New` (from `feat`), `### Improvements` and `### Fixes` (from
     `fix`). Leave an empty group out.
   - One line per user-visible change. Say what changed for the user, not which file or
     function. Merge several commits about one feature into one line.
   - Leave internal work out (`chore`, `docs`, `test`, `ci`, `build`, refactoring, specs) unless a
     user would notice it.
   - Use plain English, short sentences, no marketing words.
4. Run `pnpm release:prepare <version>` (in `kermanych/`), then replace the placeholder line
   `- ` of the new section in `CHANGELOG.md` with your notes. Check with
   `pnpm -s release:notes <version>`: it must print your notes.
5. Run the checks of section 3. If any fails, do not stop for the operator: report what failed
   and end. Nothing is published.
6. Commit `chore(release): <version>` (the two files only), `git push -u origin release/<version>`,
   and open the PR: `gh pr create --base dev --head release/<version> --title "chore(release): <version>"`.
   The body has a `## Summary` with the notes and a `## Testing` with the results of section 3.

For a **prepared version** (step 1.4), create a detached worktree on `origin/dev`
(`git worktree add --detach .gitworktree/release-<version> origin/dev`), run
`pnpm install --frozen-lockfile`, and run section 3 there. There is no PR.

## 3. Checks before the stop

On the exact commit that will be released (the worktree), in `kermanych/`:

```bash
pnpm --filter @kermanych/core --filter @kermanych/cloud --filter @kermanych/tokens build
(cd apps/ui && pnpm exec vue-tsc --noEmit)
(cd packages/core && pnpm test -- --maxWorkers=4)
(cd packages/cloud && pnpm test -- --maxWorkers=4)
(cd apps/api && pnpm test -- --maxWorkers=4)
(cd apps/ui && pnpm test -- --maxWorkers=4)
```

Every one must pass. Keep the counts (passed / failed / skipped) for the stop.

## 4. The stop

Show the operator, compactly:
- the version, and why (the rule above, or their argument), with any breaking-change flag;
- the notes exactly as they will be published;
- the commits that go in (subject lines) and the PR link (none for a prepared version);
- the results of section 3.

Ask one question: publish `v<version>`? Then wait.

- **Yes** → section 5.
- **Yes, but another version** → redo section 2 with that version. Reuse the notes, rename the
  branch and the PR, and run `release:notes` again. Then go to section 5 without asking again.
- **Change the notes** → edit them, push, show the new notes, and ask again.
- **No** → close the PR, delete `release/<version>` on `origin`, remove the worktree, and end.
  Nothing is tagged.

## 5. Publish

1. New version: `gh pr merge <number> --merge --delete-branch`. Read the merge commit with
   `gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`. Prepared version: the commit
   is the worktree's `HEAD` (`origin/dev`).
2. Tag and push: `git tag v<version> <commit>` and `git push origin v<version>`.
3. Find the run: `gh run list --workflow release.yml --branch v<version> --limit 1 --json databaseId,status`.
   It can take a minute to appear. Watch it until it completes, checking every few minutes with
   `gh run view <id> --json status,conclusion,jobs`. The mac job takes 10–40 minutes
   (code signing, notarization), the Linux job about 10.
4. Success means both `build` jobs and `release` concluded `success`. Then go to section 6.
   Anything else goes to section 7.

## 6. Checks after publishing

Download everything: `gh release download v<version> -D <tmp>/assets`.

**GitHub Release**
- It is marked latest: `gh release view v<version> --json isDraft,isPrerelease,tagName` shows not
  draft and not prerelease, and `gh release list --limit 1` shows `Latest` on it.
- Six assets: `Kermanych-<version>-arm64.dmg`, `Kermanych-<version>-arm64-mac.zip`,
  `Kermanych-<version>.AppImage`, two `.blockmap`, `latest-mac.yml` and `latest-linux.yml`.
- Both `latest-*.yml` have `version: <version>`.
- The release body equals `pnpm -s release:notes <version>` (compare after trimming whitespace).

**mac** (only when running on macOS; otherwise report «skipped: not macOS»)
```bash
D=<tmp>/assets
xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" "$D/Kermanych-<version>-arm64.dmg"
M=$(hdiutil attach -nobrowse -readonly "$D/Kermanych-<version>-arm64.dmg" | awk -F'\t' '/Volumes/{print $NF}')
spctl -a -vv "$M/Kermanych.app"                     # source=Notarized Developer ID
xcrun stapler validate "$M/Kermanych.app"           # The validate action worked!
syspolicy_check distribution "$M/Kermanych.app"     # ready for distribution
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$M/Kermanych.app/Contents/Info.plist"   # <version>
grep -E 'owner: Oleksiyukraine|repo: kermanych' "$M/Kermanych.app/Contents/Resources/app-update.yml"
hdiutil detach -quiet "$M"
Z=$(mktemp -d); ditto -x -k "$D/Kermanych-<version>-arm64-mac.zip" "$Z"
spctl -a -vv "$Z/Kermanych.app"; xcrun stapler validate "$Z/Kermanych.app"
```

**linux** (only when Docker is available; otherwise report «skipped: no Docker»). The AppImage is
an ELF runtime followed by a squashfs. Find the offset and unpack it in a container:
```bash
F=<tmp>/assets/Kermanych-<version>.AppImage
OFF=$(python3 -c "import struct,sys;b=open(sys.argv[1],'rb').read(64);print(struct.unpack_from('<Q',b,0x28)[0]+struct.unpack_from('<H',b,0x3A)[0]*struct.unpack_from('<H',b,0x3C)[0])" "$F")
docker run --rm -v "$(dirname "$F")":/a -w /a ubuntu:22.04 sh -c "apt-get update -qq >/dev/null && apt-get install -y -qq squashfs-tools file binutils >/dev/null 2>&1 && unsquashfs -q -d root -o $OFF $(basename "$F") >/dev/null && U=root/resources/app.asar.unpacked/node_modules && for f in node-pty/build/Release/pty.node better-sqlite3/prebuilds/linux-x64.node; do echo \$f; file -b \$U/\$f; objdump -T \$U/\$f | grep -oE 'GLIBC_[0-9.]+' | sort -Vu | tail -n1; done"
```
Both files must exist and be `ELF 64-bit … x86-64`, and neither may need a glibc newer than
`GLIBC_2.34`.

Any failed check is a broken published release: section 7, case C.

## 7. When something fails

After the operator's «yes» you fix failures yourself, within these limits:

- **Fix only what stopped the release:** the build, `.github/workflows/release.yml`, the packaging
  config (`kermanych/apps/ui/quasar.config.ts`, entitlements), tests. If the cause is product
  behaviour (what a user sees or does), do not change it. Stop and report.
- **Before every re-tag**, run the typecheck and the tests of the packages your fix touched
  (section 3 commands for those packages). They must pass.
- **At most two fix attempts** (two fix PRs) per release. After that, stop and report.
- **Every fix goes through a PR into `dev`** (`fix/release-<version>-<n>`, Conventional Commits),
  merged by you. Report what you changed, why, and the PR link.

Cases:

- **A. A job failed for a reason outside the code** (runner unavailable or queued out, network,
  an `actions/*` download, a notarization timeout): re-run the failed jobs once on the same commit
  with `gh run rerun <id> --failed`. If it fails the same way again, treat it as B.
- **B. The build failed and no release was created**
  (`gh release view v<version>` fails). Read the failed job's log
  (`gh run view <id> --log-failed`). Fix it in a fresh worktree on `origin/dev` and merge the PR.
  Delete the tag: `git push origin :refs/tags/v<version>`, plus `git tag -d v<version>` if it
  exists locally. Re-tag the same version on the new merge commit (section 5, steps 2–4). For a
  new version, check first that the merge kept the `CHANGELOG.md` section and the version.
- **C. The release was published but a check of section 6 failed.** First, at once:
  `gh release edit v<version> --draft=true`. The updater and new users then stop getting it, and
  the files stay. Never overwrite or re-tag a published version. Fix the cause (PR, merge), then
  release the next patch version through sections 2–6 without stopping again. Its notes say
  what the previous release got wrong in user terms, for example «Fixes the macOS download of
  1.3.0, which macOS refused to open».

## 8. Clean up and report

- `git worktree remove --force .gitworktree/release-<version>` (and any fix worktrees). Delete the
  temporary download folder. Detach any mounted dmg.
- Report:
  - the release link (`https://github.com/Oleksiyukraine/kermanych/releases/tag/v<version>`);
  - the result of each check in section 6, with `skipped` and the reason where one did not run;
  - every fix: what it changed, why, and the PR;
  - anything left open, for example a release put back to draft.
