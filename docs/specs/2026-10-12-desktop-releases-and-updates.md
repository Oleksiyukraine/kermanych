# Signed desktop releases with automatic updates and release notes

- **Status:** Approved by the operator and implemented. The first signed release and an update
  between two real releases are still to be run (see Verification).
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
     between the running one and the downloaded one. Main fetches `CHANGELOG.md` as of the
     downloaded tag (`raw.githubusercontent.com/…/v<version>/kermanych/CHANGELOG.md`) and the
     renderer cuts out those versions (`changelogBetween`). Changed during implementation from
     `UpdateInfo.releaseNotes` with `fullChangelog: true`: that field carries the HTML GitHub
     rendered for the release page, which would go into `v-html` from a remote source, while
     the changelog file is the same markdown the app already renders with `html: false`;
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
   renderer reads it at launch and every 4 hours; an app that finds itself below the minimum
   asks main for an update check at once instead of waiting for the next one. A packaged app
   whose version is lower shows a blocking screen «This version is no longer supported»: its
   button installs the downloaded update (or waits for the download), and a link opens
   `releases/latest`. When the policy cannot be read (offline, cloud down), nothing is blocked,
   in line with «Local work never
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
   One configuration check stays, and it is not a test of the build: a tag build refuses to
   start without the signing secrets (`CSC_LINK`, `APPLE_API_KEY`), because an unsigned macOS
   build would be published to everyone and Squirrel.Mac would refuse to install it.

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

- **Build config** `apps/ui/quasar.config.ts`: `identity: null` is gone; mac targets `dmg` and
  `zip` for `arm64`, `hardenedRuntime: true`, `entitlements` / `entitlementsInherit` from the new
  `src-electron/entitlements.mac.plist` (`allow-jit`, `allow-unsigned-executable-memory`),
  `notarize: true`; `linux` targets an x64 AppImage; `publish` names the GitHub repository
  (writes `app-update.yml` into the bundle and `latest-*.yml` next to the artifacts). `appId`
  stays `com.kermanych.app`. `build.env.APP_VERSION` hands the package version to the renderer.
  On Linux, `beforePackaging` runs `node-gyp rebuild` for `node-pty` when the deployed tree has
  neither a prebuild nor a build.
- **Electron main** `src-electron/login-shell-path.ts` (decision 5), `src-electron/updater.ts`
  (`electron-updater`, IPC `kermanych:update:*`, `quitAndInstall(true, true)` so an AppImage
  relaunches too), `electron-main.ts` wires both before the api boots;
  `electron-preload.ts` exposes `window.kermanych.updates` (`packaged`, `state`, `check`,
  `install`, `changelog`, `onState`); main passes `--app-packaged` to the preload.
- **Core** `packages/core/src/app-release.ts`: `compareAppVersions`, `isBelowMinimumVersion`,
  `changelogEntries` / `changelogSection` / `changelogBetween` (shared by the app and the
  release script).
- **Cloud** `supabase/migrations/20261012120000_app_release_policy.sql`;
  `packages/cloud/src/app-release.ts` `getMinAppVersion` (null on any failure).
- **UI** `stores/app-update.ts` (state, policy, last seen version in `localStorage`, bundled
  `CHANGELOG.md?raw`); `components/AppUpdateBanner.vue` in `MainLayout.vue` (restart
  confirmation counts `ACTIVE_STATUSES`); `components/AppUnsupported.vue` and
  `components/AppWhatsNew.vue` in `App.vue`, so the gate covers the sign-in screen too;
  `lib/markdown.ts` `renderReleaseNotes` (`breaks: false`, as on the release page); Settings →
  «Загальне» shows the version and «Що нового»; the header shows the real version instead of a
  fixed `v1.0`; `i18n` en/uk `appUpdate.*`.
- **Release tooling** `scripts/release.ts` (`prepare`, `notes`) with root scripts
  `release:prepare` / `release:notes` and `tsx` as a root dev dependency;
  `kermanych/CHANGELOG.md`; `.github/workflows/release.yml` (matrix `macos-14` + `ubuntu-22.04`,
  then `release` on tags only).
- **API build fix** `apps/api/src/http/jira.controller.ts`: the attachment download reads the
  web stream with a reader instead of `for await`. The `ReadableStream` type the build resolves
  has no async iterator, so `nest build` — and with it `pnpm build:app`, the release build —
  failed on `main`.

## Verification

- `packages/core` `test/app-release.spec.ts` (version order and refusals, the minimum-version
  gate never locking out on an unreadable policy, section extraction with a heading-like line
  inside a code block, empty and missing sections, `changelogBetween` bounds and its fallback).
  Suites: `packages/core` 200 passed; `packages/cloud` 155 passed, 65 skipped (local-stack
  suite); `apps/ui` 576 passed; `apps/api` 880 passed and 2 failed in
  `test/rpc-session.compact.spec.ts`, already recorded as failing in earlier specs.
- `vue-tsc --noEmit` in `apps/ui`: only the known `test/runtime-messages.spec.ts` error remains.
- `pnpm release:notes` / `release:prepare`: notes printed for 0.1.0; a tag differing from the
  package version, a malformed version, an equal or lower version and an empty new section all
  refused; `prepare 0.2.0` wrote the version and the section (reverted afterwards).
- `pnpm build:app --publish never` on this Mac (no signing identity): `Kermanych-0.1.0-arm64.dmg`,
  `…-arm64-mac.zip`, both blockmaps and `latest-mac.yml`; signing skipped, notarization skipped;
  `app-update.yml` in the bundle names `Oleksiyukraine/kermanych`; `CFBundleShortVersionString`
  0.1.0.
- The packaged app started from a launchd-like environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  temporary DB and userData): its main process had the login shell's `PATH`, and `omp --version`
  answered `omp/18.8.4` (`omp` lives in `~/.local/bin`). The updater checked GitHub and logged
  «No published versions on GitHub»; the app kept running.
- The UI against a preview api with a stand-in `window.kermanych.updates`: «Що нового у 0.1.0»
  once after moving from 0.0.9; the banner on `ready` 0.2.0 with notes for 0.2.0 and 0.1.1 only
  (raw `<script>` shown as text); «Перезапустити» with 7 active seeded sessions asked
  («Зараз працюють агенти: 7…») and installed on confirm, with none it installed at once; a
  policy of 9.9.9 showed «Потрібне оновлення», triggered a check, kept the button disabled until
  `ready`, and did not close on `Escape`; Settings → «Загальне» showed 0.1.0 and the changelog.
- `getMinAppVersion` against the team's hosted project (table not pushed yet): `null`, so
  nothing is blocked.
- The migration in a throwaway Postgres 17 with `anon`/`authenticated` roles: `anon` reads
  `0.0.0`; `anon` update and `authenticated` insert are denied; a second row and a malformed
  version are rejected; a migration-style update to 0.4.0 is read back by `anon`.
- Not verified, needs the operator's credentials or a second release: signing and notarization,
  the workflow on GitHub, the Linux AppImage build, and a real update 0.1.0 → 0.1.1 (Squirrel.Mac
  installing after `before-quit` has closed the api). Plan: the contributor tries a
  `workflow_dispatch` AppImage; then tag `v0.1.0`, install from the dmg, check
  `spctl -a -vv` («Notarized Developer ID»), start a session from a Finder launch; then tag
  `v0.1.1` and check the banner, «Що нового», the restart confirmation, the restart into 0.1.1
  with its «Що нового» once, and that a plain quit also installs.

## Documentation impact

`kermanych/README.md`, «Desktop app»: installing from `releases/latest` (Apple Silicon; Linux
AppImage with the `libfuse2` requirement and the Ubuntu 24.04 AppArmor sandbox note), how
updates arrive, the release procedure above, the `min_app_version` rule in «Applying a migration
to the team's project», and the unsigned-build note limited to local `pnpm build:app`. New
`kermanych/CHANGELOG.md`.
