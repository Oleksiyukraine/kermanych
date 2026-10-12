# Signed desktop releases with automatic updates and release notes

- **Status:** Decisions agreed with the operator; implementation pending approval.
- **Date:** 2026-10-12

## Goal

People outside the team want to try Kermanych on their own projects. They get a signed,
notarized macOS `.dmg` (and a Linux AppImage) from a public download page instead of building
from source, and every later version reaches them automatically, together with release notes
that tell them what changed.

## Context

- `pnpm build:app` builds the desktop app through Quasar's electron mode and
  `electron-builder@24.13.3` (`apps/ui/quasar.config.ts`): `mac: { target: 'dmg', identity:
  null }`, an unsigned build for the host architecture. Signing, notarization and automatic
  updates were deferred in `docs/superpowers/specs/2026-08-10-desktop-electron-packaging-design.md`
  (§6), which also records that an Apple developer account exists.
- `@kermanych/ui` has version `0.0.0`. There are no git tags, no GitHub Releases and no CI
  (`.github/` does not exist). The repository `Oleksiyukraine/kermanych` is public.
- The local registry `~/.kermanych/kermanych.sqlite` migrates forward only (`pragma
  user_version`), so a newer build opens an older file.
- Every client uses the team's hosted Supabase project. Migrations are pushed by hand, before the
  UI that needs them ships (README, «Applying a migration to the team's project»), so a
  breaking migration reaches old clients first.
- Quitting the app runs `before-quit` → `nest.close()`, which stops every `omp`/`claude`
  child, preview server and terminal. Sessions can be continued after a restart
  («Продовжити», `--resume`), but a turn in progress is cut off.
- Agent children are spawned by bare name: `spawn("omp", …)` in `apps/api/src/rpc/rpc-session.ts`
  and `omp models/usage/config` in `models.service.ts`, `usage.service.ts`,
  `runtime-check.service.ts`, `skills.service.ts`. An app launched from Finder, the Dock or a
  Linux desktop launcher inherits the minimal launchd/session `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), which has no Homebrew, bun, nvm or `~/.local/bin`.
  Only the integrated terminal already works around this (login shell, `terminal.service.ts`).
  [INFERENCE: not reproduced on a packaged build; nobody on the team launches the app outside a
  terminal.]
- `electron-builder@24.13.3` notarizes with an App Store Connect API key when `notarize` is set
  and `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are in the
  environment (`app-builder-lib/src/macPackager.ts`, `getNotarizeOptions`). No upgrade is needed.
- `node-pty` 1.1 ships N-API prebuilds for macOS and Windows only. The packaged tree is produced
  by `pnpm deploy --ignore-scripts` with `npmRebuild: false`, so a Linux build has no `node-pty`
  binary unless the build compiles one.
- One contributor runs Kermanych on Linux from source (`pnpm dev:app`) and everything works for
  him, so the application itself runs on Linux. Only the Linux packaging is untested.

## Decisions

1. **Updates: `electron-updater` with GitHub Releases as the feed.** Each release publishes
   the `.dmg` (first install), the `.zip` (what Squirrel.Mac installs), the AppImage and
   `latest-mac.yml` / `latest-linux.yml`. The app checks, downloads and installs on its own.
   The public repository serves the feed without a token. Rejected: a «new version available,
   download it» notice only (people stay on old versions, which is dangerous with the shared
   Supabase project, see decision 8); a Homebrew cask as the main channel (see decision 5a).

2. **Release notes: `kermanych/CHANGELOG.md` is the single source.** One `## <version> —
   <YYYY-MM-DD>` section per version. The release workflow puts the section into the body of
   the GitHub Release, and the file is bundled into the app. The user sees notes twice:
   - **before installing**: the update banner's «What's new» shows the notes of every version
     between the running one and the downloaded one (`fullChangelog: true`, from
     `UpdateInfo.releaseNotes`);
   - **after updating**: on the first launch of a new version a «What's new in X» dialog shows
     that version's section from the bundled file (it works offline). Settings → «Загальне»
     shows the running version and a «What's new» entry that opens the bundled changelog.
   The first launch after a fresh install shows no dialog: it only records the version.
   Rejected: notes written only in the GitHub web UI (outside review, not available offline,
   a manual release step); notes only before installing (anyone who restarts without reading
   never sees them).

3. **Releases are built, signed, notarized and published by GitHub Actions on a `v*` tag.**
   Credentials live in repository secrets: `CSC_LINK` (Developer ID Application certificate as
   base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (`.p8` contents, written to a file in the
   job), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Rejected: a local `pnpm release:app` on the
   operator's Mac (the release would contain whatever the working copy holds and depend on one
   machine).

4. **Platforms: macOS and Linux (AppImage, x64).** Linux is a second job in the same workflow
   and publishes into the same GitHub Release. Before the first tag, the Linux contributor
   checks an AppImage from a build-only run (decision 9): install, a session, the terminal, then
   (after the second release) an update. Windows is out of scope: native sessions are refused
   there in code (`terminal.service.ts`), the app has never run on Windows, and signing needs a
   paid certificate. Adding it later means one more job and `latest.yml`, with no change to the
   update mechanism.

5. **The packaged app takes `PATH` from the user's login shell.** Before `bootstrap()`, a
   packaged app (`app.isPackaged`) on macOS or Linux runs `$SHELL -ilc` once, with a few seconds'
   timeout, prints the environment between markers and copies `PATH` into `process.env`. If the
   shell fails or times out, the system `PATH` stays. Only `src-electron` changes. Every
   `spawn` of the API then finds the same programs the user's terminal finds. Rejected: a
   separate task (the release would be useless without it); documenting «launch from a
   terminal».

   5a. **Homebrew is not a replacement for the `.dmg`.** A cask installs the same `.app`, which
   gets the same minimal `PATH` when launched; Homebrew quarantines the download, so it still
   needs signing; `brew upgrade` is manual and shows no release notes. A cask in an own tap that
   points at the GitHub Release `.dmg` with `auto_updates true` can be added later as a separate
   task.

6. **macOS: Apple Silicon (arm64) only.** The CI runner is arm64. `better-sqlite3` reaches the
   bundle through `pnpm deploy --ignore-scripts` with the host's binary, so x64 needs its own
   native step and a machine nobody has to verify it; macOS 26 is the last release for Intel
   Macs. The README and every release page say «requires a Mac with Apple Silicon». Rejected: a
   separate x64 `.dmg` or a universal binary (unverified output, longer builds).

7. **Updates install on quit or on request, never by force.**
   - The packaged app checks on launch and every 4 hours, and downloads in the background
     (`autoDownload: true`).
   - When an update is downloaded, a non-blocking banner in the main layout shows
     «Version X is ready · What's new · Restart».
   - A normal quit installs it (`autoInstallOnAppQuit: true`).
   - «Restart» with active agents (`ACTIVE_STATUSES`) first asks for confirmation: N agents are
     running, they will be stopped, their conversations can be continued. With none active it
     restarts at once (`quitAndInstall()`).
   - The app never restarts by itself. Updater errors (offline, an unsigned local build) are
     logged, not shown, and the next cycle retries.
   - A dev run (`!app.isPackaged`) checks nothing.
   Rejected: asking before the download (one extra click for nothing); restarting
   automatically when idle (closes terminals and preview servers by surprise).

8. **The cloud names a minimum supported app version.** A migration adds a one-row table
   `public.app_release_policy (min_app_version text not null)`, seeded with `0.0.0`, readable by
   `anon` and `authenticated`, with no write policy (it changes only through migrations). The
   renderer reads it on launch and with every update check. A packaged app whose version is
   lower shows a blocking screen «This version is no longer supported»: its button installs the
   downloaded update (or waits for the download), and a link opens `releases/latest`. When the
   policy cannot be read (offline, cloud down), nothing is blocked, in line with «Local work never
   waits for the cloud». A migration that breaks older clients must raise `min_app_version` in
   the same SQL file; the README states this rule next to the migration procedure. Rejected:
   migration discipline alone (nobody knows when everyone has updated, and one mistake breaks
   screens silently); a minimum version in the GitHub Release metadata (separate from the
   migration, and `electron-updater` has no such field).

9. **A tag publishes the release at once, without an automated gate.** The workflow builds
   both platforms and then creates a published (not draft) GitHub Release from the tag. Clients
   receive it on their next check. The workflow can also be started by hand
   (`workflow_dispatch`): it builds and attaches the artifacts to the run without creating a
   release. This is how the Linux contributor checks the first AppImage (decision 4). The
   release is created only after both platform jobs succeed, so one tag never publishes half a
   release. Rejected and recorded as a known risk: a draft step, and a CI gate
   (`codesign --verify --deep --strict`, `spctl -a`, `stapler validate`, plus a launch in a smoke
   mode that boots the API, opens SQLite and spawns a shell through `node-pty`). Without them, a
   build that fails at launch or breaks the updater reaches every client, and such a build cannot
   repair itself through an update: each client then has to reinstall the `.dmg` by hand.

10. **Release notes are written in English.** The in-app release-notes generator writes English
    (`2026-10-09-release-notes-english.md`), so its draft is usable as is, and the GitHub Release
    page is readable by anyone. Rejected: Ukrainian only; both languages (two files per version).

11. **Versions are semver, starting at `0.1.0`.** `apps/ui/package.json` holds the version
    (`app.getVersion()`, the update feed and `min_app_version` all compare it as semver). New
    features raise the minor, fixes the patch. The operator decides when to go to `1.0.0`. Tags
    are `v<version>`. Rejected: starting at `1.0.0`; CalVer.

## Release procedure (what the operator does)

One-time setup:

1. Create a **Developer ID Application** certificate, export it from Keychain as `.p12` with a
   password.
2. Create an **App Store Connect API key** (`.p8`, Key ID, Issuer ID).
3. Add the secrets of decision 3 to the GitHub repository.
4. Push the `app_release_policy` migration to the team's project.

Every release:

1. Merge the work into `main` as usual.
2. `pnpm release:prepare <version>`: checks that the version is valid semver and higher than the
   current one, writes it into `apps/ui/package.json`, and adds an empty
   `## <version> — <date>` section to `CHANGELOG.md`. Write the notes (a draft can come from
   Менеджмент → «Реліз-ноти»), open a PR, merge it.
3. `git tag v<version> && git push origin v<version>`.
4. The workflow checks that the tag equals the package version and that the changelog section
   exists and is not empty, builds both platforms, and publishes the release with the notes.
5. New users download from `https://github.com/Oleksiyukraine/kermanych/releases/latest`.

## Changes

- **Build config** `apps/ui/quasar.config.ts`: drop `identity: null`; mac targets `dmg` and
  `zip` for `arm64`, `hardenedRuntime: true`, `entitlements` /
  `entitlementsInherit` from a new `src-electron/entitlements.mac.plist`
  (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`;
  `disable-library-validation` only if the signed build shows it is needed), `notarize: true`;
  `linux: { target: 'AppImage', category: 'Development' }`;
  `publish: { provider: 'github', owner: 'Oleksiyukraine', repo: 'kermanych' }` (writes
  `app-update.yml` into the app). `appId` stays `com.kermanych.app`: changing it would break
  updates. On Linux, `beforePackaging` compiles `node-pty` in the deployed tree, because there
  is no prebuild. Without signing credentials, a local `pnpm build:app` still produces an
  unsigned build: `electron-builder` skips signing when there is no identity and skips
  notarization when there are no `APPLE_*` variables.
- **Electron main** `src-electron/`: a new login-shell `PATH` module (decision 5); a new updater
  module that owns `electron-updater` (check schedule, events to the renderer, `quitAndInstall`);
  `electron-preload.ts` exposes `appVersion`, `isPackaged` and an `updates` bridge (state, «What's
  new» notes, restart) on `window.kermanych`.
- **Dependencies** `apps/ui/package.json`: `electron-updater` as a runtime dependency; version
  `0.1.0`.
- **UI** `layouts/MainLayout.vue`: the update banner and the unsupported-version screen; the
  «What's new» dialog (bundled `CHANGELOG.md` rendered with the existing `markdown-it`);
  `pages/SettingsPage.vue`, section `app-general`: the version and «What's new»; the last seen
  version in `localStorage`; `i18n` en/uk; the restart confirmation counts `ACTIVE_STATUSES`.
- **Cloud** a migration `supabase/migrations/<timestamp>_app_release_policy.sql`; a read of the
  policy in `packages/cloud`.
- **Release tooling** `scripts/release-prepare.ts` and a root script `release:prepare`;
  `kermanych/CHANGELOG.md` with the `0.1.0` section; `.github/workflows/release.yml` at the
  repository root (`working-directory: kermanych`): jobs `mac` (`macos-14`), `linux`
  (`ubuntu-22.04`, the older glibc runs on more distributions), and `release` (tag only, needs
  both, creates the release from the changelog section with all assets).

## Verification

- **Tests**: changelog section extraction (the version's section only, missing or empty
  section, last section in the file) and the minimum-version comparison (lower, equal, higher,
  unreadable policy does not block), because these decide what users see and whether they are
  locked out.
- **Release tooling**: `pnpm release:prepare` with a lower, equal and invalid version refuses;
  the workflow refuses a tag that differs from the package version and a version without notes.
- **macOS, real rollout**: tag `v0.1.0`. Download the `.dmg` on a Mac, open it from Finder:
  Gatekeeper raises only the standard «downloaded from the internet» prompt.
  `spctl -a -vv` reports «Notarized Developer ID». Start a session: `omp` is found (decision 5).
  Tag `v0.1.1`: the running 0.1.0 shows the banner and «What's new». «Restart» with a running
  agent asks first. After the restart the app is 0.1.1 and shows «What's new in 0.1.1» once.
  Also check that a quit with a downloaded update installs it.
- **Linux**: before `v0.1.0`, the contributor runs the AppImage from a `workflow_dispatch` build
  (session, terminal, launch from the desktop menu); after `v0.1.1`, the AppImage updates.
- **Minimum version**: against a local Supabase stack, `min_app_version = '9.9.9'` gives the
  blocking screen; with the cloud unreachable the app starts normally.

## Documentation impact

`kermanych/README.md`, «Desktop app»: installing from `releases/latest` (Apple Silicon; Linux
AppImage with the `libfuse2` requirement and the Ubuntu 24.04 AppArmor sandbox note), how
updates arrive, the release procedure above, the `min_app_version` rule in «Applying a migration
to the team's project», and the unsigned-build note limited to local `pnpm build:app`. New
`kermanych/CHANGELOG.md`.
