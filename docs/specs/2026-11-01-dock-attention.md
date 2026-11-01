# The Dock icon calls the operator: a «ваш хід» count and a bounce

- **Branch:** `feature/notify-user-agent-action`
- **Scope:** code in `apps/ui` only — the Electron main process and preload (`src-electron/`),
  the bridge types, `lib/attention.ts`, `stores/orchestrator.ts`, `stores/minion.ts`,
  `layouts/MainLayout.vue`, `pages/AgentsPage.vue`, `pages/DesignPage.vue`, Settings
  (`lib/settings.ts`, `pages/SettingsPage.vue`), i18n (uk, en), tests under `apps/ui/test`; plus
  `kermanych/README.md`.
- **Builds on:** `docs/specs/2026-09-29-sidebar-attention-status.md` (the attention tally and the
  seen marks), `docs/superpowers/specs/2026-08-10-desktop-electron-packaging-design.md` §3.4 (the
  native notifications).
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-10-31),
  approved 2026-11-01, implemented on this branch (see «Verification»).

## Goal

The operator asked how Kermanych can tell them that an agent needs an action from them: a push
notification, or a bouncing Kermanych icon. The answer for now: the Kermanych icon in the macOS
Dock shows how many agents wait for the operator and bounces once when one more starts to wait.
Pop-up notifications come later. They need a signed app, and signing is a separate task.

## Context

- **Pop-ups exist but never show on macOS.**
  - The renderer already creates a `new Notification()` in three places, each only while
    `!document.hasFocus()`:
    - a session moving into `waiting_input`, `error`, `conflict`, `done` or `in_review`
      (`shouldNotify`, `packages/core/src/status.ts:12-21`; `stores/orchestrator.ts:209-226`), for
      any session kind;
    - a memory-watchdog alert (`orchestrator.ts:272-294`);
    - a «Посіпака» pause (`stores/minion.ts:33-41`).
  - A click calls `window.kermanych.focus()` (IPC `kermanych:focus` → `show()` + `focus()`,
    `src-electron/electron-main.ts:184-189`) and selects the session.
  - Electron 43.4.0 shows notifications through `UNNotification`. Since Electron 42 that needs a
    code-signed app; an unsigned one gets a `failed` event
    ([Electron 42 release notes](https://www.electronjs.org/blog/electron-42-0)). `pnpm dev:app`
    runs the stock `Electron.app` from `node_modules`, which is `adhoc,linker-signed` with no team
    identifier. `pnpm build:app` builds with `identity: null` (`quasar.config.ts:84-86`). Nothing
    listens for `onerror`, so the failure is silent.
- **Probes on the operator's machine** (macOS 27.0.1, 2026-10-31; throwaway apps in `/tmp`, removed):
  - The dev `Electron.app`: a main-process `Notification` emits `failed: UNErrorDomain error 1`.
    A renderer `new Notification()` fires `error`, and `Notification.permission` is `denied`. The
    system log shows `usernotificationsd` refusing `com.github.Electron` («Entitlement
    'com.apple.private.usernotifications.bundle-identifiers' required to request user
    notifications»). The same refusal was logged at 22:14, before any probe ran, from an earlier
    run of the operator's own dev app.
  - A copy re-signed ad hoc (`codesign --sign -`, its own bundle id) emits `failed: Notifications
    are not allowed for this application`. An ad-hoc signature is not enough.
  - No code-signing identity is installed (`security find-identity -v -p codesigning` → 0).
  - **The Dock works unsigned:** `app.setBadgeCount(7)` draws a red «7» on the icon (Dock
    screenshot). `app.dock.bounce('informational')` returns a request id while the app is not
    active, and −1 while it is active, as `dock.md` documents.
- **Nothing touches the Dock today** except the dev icon (`electron-main.ts:204-214`). Nothing
  counts what waits app-wide. There are only the per-project and per-workspace sidebar marks
  (`lib/attention.ts`, `MainLayout.vue:976-977`) and the header switcher's summary
  (`attentionOutside`).
- **When a session reads `waiting_input`.** Only when the harness asks through an interactive
  tool:
  - omp `ask` (`extension_ui_request`);
  - native claude `AskUserQuestion`, `ExitPlanMode`, `PermissionRequest` and the asking
    `Notification` types;
  - native codex `request_user_input` and `PermissionRequest`.

  Managed claude-code never reaches it (`apps/api/src/runtime/claude-code-runtime.ts:188,314`). A
  question asked in plain text ends the turn as `done`. This deep-analysis session was `done` in
  the registry while it waited for the operator's answer.
- **Unread results.** `stores/seen.ts` keeps `kermanych.sessions.seen` and a baseline. Only
  `AgentsPage.vue:1745-1752` writes a mark: the open session, while the window is visible. A
  design session opens on «Дизайн» only (`MainLayout.vue:786-794`), which marks nothing. Its
  sidebar ring therefore never clears (finding 893d0c31).
- **Shell.**
  - The app has one window, and closing it quits (`electron-main.ts:225`).
  - There is no `app.on('activate')`. Electron 43 returns `hasVisibleWindows` from
    `applicationShouldHandleReopen` (`shell/browser/mac/electron_application_delegate.mm:127-131`).
    So a Dock click on the running app does not restore its window when that window is minimised
    (read from the source; the smoke confirms it).
  - Renderer → main calls go over `kermanych:*` IPC through the preload bridge `window.kermanych`
    (`electron-preload.ts:26-73`; types in `src/types/kermanych-bridge.d.ts:113-139`). Every
    member except `apiBase` and `focus` is optional, so the web build and a stale preload degrade.
- **Settings.**
  - The app scope has «Загальне» (`app-general`: theme, language, version; applied on click),
    «Гарячі клавіші», «ШІ-провайдер», «Ресурси машини» and «Акаунт» (`lib/settings.ts:45-60`).
  - Device-local preferences live in localStorage under `kermanych.*`.
  - The Boolean control is `KCheckbox`, with a `set__note` hint under it.

## Decisions

The interview settled decisions 1–6. Decisions 7–11 came up while writing this document, and
approving the document covers them.

1. **Dock icon only; pop-ups wait for signing.**
   - This task adds a count badge and a bounce to the Dock icon.
   - The pop-up code stays (with the trigger of decision 7). It starts to show once the app is
     signed. The operator does the signing as a separate task.
   - Settings say that macOS blocks pop-ups today (decision 5).

   *Rejected:*
   - Sign in this task. It needs an Apple certificate that is not on the machine, and it changes
     the build and the distribution.
   - Remove the pop-up code. The code is right; only the signature is missing.
   - A phone push through Telegram, Slack or ntfy. That is a new external service, and the agent's
     question would leave the machine. The team cloud deliberately does not sync prompt text
     (`kermanych/docs/superpowers/plans/2026-08-21-team-cloud-status-sync.md:1847`).

2. **The number counts «ваш хід».**
   - A session counts while it is in one of these states:
     - `waiting_input`;
     - `error` or `conflict`;
     - `done` or `in_review`, and unread.
   - That is `input + error + result` of the sidebar tally, summed over every project: the
     sidebar's marks without «працює».
   - An unread result leaves the number once the operator opens the agent.
   - An error stays until the agent is restarted, archived or deleted, like the sidebar's red dot.

   *Rejected:* `waiting_input` only, and `waiting_input` plus errors. Both miss a question asked
   in plain text, and every question of managed claude-code.

3. **The same sessions as the sidebar.**
   - The set is that of `attentionByProject`: not a chat, and `bucketOf` is neither `completed`
     nor `tasks`. So archived and merged work and backlog cards are out, and a fork follows its
     parent. `stopped` never counts.
   - In practice: agents, deep analysis, «Посіпака» runs, designs, and discussion or review
     branches. Chats are out.
   - «Дизайн» marks the open design seen by the rule of «Агенти»: open, and the window visible.
     A design result can then leave the number. This also fixes finding 893d0c31.

   *Rejected:*
   - Add chats. The «Чат» page would need its own seen rule, and the number would no longer
     match the sidebar.
   - Leave out «Посіпака» runs. Its PR or «потрібне рішення» is the operator's turn.
   - Leave out designs. Their results would stay in the number forever.

4. **One bounce for each new «ваш хід» event.**
   - An event: a session of decision 3 moves into `waiting_input`, `error`, `conflict`, `done` or
     `in_review` from another status (`shouldNotify(prev, next)`).
   - Each event asks for one `informational` bounce. macOS bounces only while Kermanych is not
     the active app.
   - The event does not depend on unread. A result that lands in an agent open in a visible
     window is marked seen at once and does not raise the number. It still bounces, because the
     operator is in another app.
   - The snapshot the socket sends on every (re)connect never bounces; it only sets the number.
     The socket is not paused while the window is hidden, so a reconnect has no missed
     transitions to announce.

   *Rejected:*
   - Bounce until the operator comes back (`critical`). With many agents the icon would bounce
     nearly all the time, screen sharing included.
   - Until-return for questions and errors only. The urgency would follow how the harness asked,
     not what it asked.
   - No bounce.

5. **Settings → Застосунок → «Сповіщення».**
   - A new app category, `app-notifications`, placed after «Загальне».
   - Two checkboxes, both on by default: «Число на іконці» and «Підстрибувати». They are
     device-local (localStorage, like the theme) and apply on click.
   - Under them, one read-only line about pop-ups:
     - «macOS їх блокує»: the running app has no Apple team signature;
     - otherwise, they are governed by the macOS notification settings.
   - The web build has no Dock. It shows one note instead of the controls.

   *Rejected:*
   - Put the switches into «Загальне». Its blurb is about appearance.
   - No switches. Turning the bounce off for a call should be possible.

6. **A Dock click brings the window back, nothing more.**
   - On `app.on('activate')`, main restores a minimised window, shows it and focuses it. The
     pop-up click (`kermanych:focus`) uses the same routine.
   - It never acts before the window's first `ready-to-show`, so the splash keeps its no-flash
     start.
   - It never opens an agent.

   *Rejected:*
   - A Dock menu that lists the waiting agents.
   - Opening the agent that has waited longest. Every switch to Kermanych through the Dock would
     move the operator somewhere.

7. **Whatever asks for a pop-up also bounces, and both use one trigger.**
   - `isYourTurnEvent(prev, session, parentOf)` (decision 4) drives both the bounce and the
     session pop-up. So pop-ups stop firing for chats and completed sessions, and they follow
     this rule once signing lands.
   - The memory-watchdog alert and the «Посіпака» pause bounce under the conditions of their
     pop-ups: not for the echo of the operator's own kill, not for a pause the app found at start.
     The bounce needs no focus check: macOS ignores it while the app is active.

8. **The renderer decides, main only draws.**
   - The renderer holds the sessions, the seen marks and the settings, so it computes the number
     and the events.
   - Main gets three IPC channels:
     - `kermanych:dock:badge` (`app.setBadgeCount(n)`; 0 hides the badge);
     - `kermanych:dock:bounce` (cancels the previous request, then
       `app.dock.bounce('informational')`), macOS only;
     - `kermanych:notifications-blocked`. It runs once per launch: `codesign --display
       --verbose=2` on the running executable; no Apple team identifier means blocked.
   - The bridge gets optional `dock: { setBadge, bounce }` and `notificationsBlocked()`. Without
     them, nothing happens.

   *Rejected:* an api-side notifier handed in through `bootstrap({ … })`, like `keepAwake`. The
   api has neither the seen marks (renderer localStorage) nor the settings.

9. **The signed-in shell pushes the number.**
   - `MainLayout.vue` already computes `attentionById`. It sends `yourTurnCount(sumAttention(…))`
     whenever that number changes or «Число на іконці» flips.
   - It sends 0 when it unmounts (sign-out).
   - Before the first snapshot the session list is empty, so the number is 0.

10. **Seen marks live in one place.** The watcher at `AgentsPage.vue:1745-1752` moves into a
    composable `useMarkSeen(session)`. «Агенти» and «Дизайн» both use it.

11. **`persisted()` is shared.**
    - The device-local ref helper at `lib/doc-preview.ts:26-43` moves to `lib/persisted.ts`.
    - The two Dock settings use it: `kermanych.dock.badge` and `kermanych.dock.bounce`, stored as
      `'1'`/`'0'`, on by default.

## Changes

- `src-electron/electron-main.ts`:
  - the three IPC channels of decision 8;
  - `bringBack()` for `app.on('activate')` and `kermanych:focus` (decision 6).
- `src-electron/electron-preload.ts`, `src/types/kermanych-bridge.d.ts`: `dock` and
  `notificationsBlocked`.
- `src/lib/attention.ts`:
  - `isTracked(session, parentOf)`, extracted from `attentionByProject`, which now uses it;
  - `yourTurnCount(attention)`;
  - `isYourTurnEvent(prev, session, parentOf)`.
- `src/lib/persisted.ts` (new, moved from `lib/doc-preview.ts`).
- `src/lib/dock.ts` (new): the two settings refs, and `bounceDock()`, which checks «Підстрибувати»
  and calls the bridge.
- `src/stores/orchestrator.ts`:
  - `session_update` runs `isYourTurnEvent`, then `bounceDock()` and the existing pop-up;
  - the machine alert calls `bounceDock()`.
- `src/stores/minion.ts`: `announce()` calls `bounceDock()`.
- `src/composables/useMarkSeen.ts` (new); `pages/AgentsPage.vue` and `pages/DesignPage.vue` use it.
- `src/layouts/MainLayout.vue`: pushes the number (decision 9).
- `src/lib/settings.ts`: the `app-notifications` row. `src/pages/SettingsPage.vue`: its pane.
- `src/i18n/{uk,en}/index.ts`:
  - `settings.categories.app-notifications.{label,sub,blurb}`;
  - `settings.notifications.*`: the two checkboxes, their hints, the two pop-up lines and the
    web-build note.
- `src/stores/board.ts`: its comment on the `@kermanych/core/status` import no longer points at
  `orchestrator.ts`, which no longer has that import.
- `test/attention.spec.ts`: the count and the event predicate.
- `kermanych/README.md`: see «Documentation impact».

## Verification

- **Unit tests.** `apps/ui`: `vitest run --minWorkers=1 --maxWorkers=4` — 71 files, 781 tests
  pass. `test/attention.spec.ts` adds:
  - `yourTurnCount` over two projects: it counts the question, the conflict, the failure and the
    unread result (4). It leaves out two running sessions, a read `in_review` and a `stopped` one.
  - `isYourTurnEvent`:
    - it fires on a move into each of the five statuses, and for a session first seen in `error`;
    - it stays quiet on a repeat, and on moves into `thinking`, `stopped` and `merged`;
    - it stays quiet for a chat, an archived agent and a fork of a merged parent.
  - The planned case «fires for a result that is already read» was dropped. The predicate takes
    no read state, so such a test could not fail.
- **Static checks.** `vue-tsc --noEmit` in `apps/ui`, which covers `src-electron` too: clean. The
  i18n completeness spec is part of the suite and passes.
- **Smoke** (2026-11-01), in an isolated desktop instance from this worktree:
  - **Setup.**
    - `quasar dev -m electron -- --user-data-dir=<tmp> --remote-debugging-port=9333`.
    - `KERMANYCH_DB` and `KERMANYCH_SKILLS_HOME` in a temp dir; `KERMANYCH_SEED=1`,
      `KERMANYCH_PREVIEW=1`, `VITE_KERMANYCH_PREVIEW=1`.
    - The operator's dev `Electron.app` binary through `ELECTRON_OVERRIDE_DIST_PATH`.
    - The renderer was driven through CDP, and main through its inspector. The operator's app,
      registry and seen marks were not touched, and everything was removed afterwards.
  - **The number.**
    - The seed gave 4: the question, two failures and the conflict. One failure is the seeded
      `queued` agent, which failed to start at boot.
    - `app.getBadgeCount()` returned 4, and a screenshot of the Dock region showed «4» on the
      instance's icon.
    - «Число на іконці» off → 0; on → 4.
  - **Unread results.**
    - With the seen baseline moved back, the number was 10 (six results).
    - Opening an agent in «Агенти» and then a design in «Дизайн», while the window was visible,
      took it to 9 and then 8. The sidebar marks agreed.
    - While the window was covered, opening marked nothing: the visibility rule.
    - Two seeded rows were flipped to `native` in the temp DB first. Otherwise opening a seeded
      `done` agent resumes it, the inert seed's resume fails, and the agent turns `error`. The
      number then swaps a result for an error and stays put. This is the preview's existing
      behaviour.
  - **The bounce.**
    - The instance was hidden (`app.hide()`). Then `GET /api/sessions/:id/finish` on the
      conflicted agent, whose worktree was real and had no merge in progress, moved it
      `conflict → done`.
    - `app.dock.bounce`, wrapped through the inspector, was called once with `informational` and
      returned request 0. A Dock screenshot caught the icon mid-bounce.
    - With «Підстрибувати» off, the same transition requested no bounce.
  - **The window comes back.** A minimised window was restored and shown on
    `app.emit('activate')`. The real Dock click was not automated, because it needs Accessibility
    permission; it is left to the operator.
  - **Settings.** In the instance, «Налаштування → Сповіщення» showed both switches on, and
    «macOS їх блокує…», because the dev `Electron.app` has no team identifier.
  - **Web build.** The same dev server, opened in a plain browser against a standalone preview api,
    has no bridge. The pane shows only the desktop-only note, and the console has no errors.
- **For the operator after merge, in their own app.** An agent finishes a turn while they work in
  another app: one bounce, and the number goes up by one. Opening the agent takes the number down
  by one. With the window minimised, a click on the Dock icon brings it back.

## Out of scope

- Signing and notarisation: the operator's separate task.
- The pop-up's content and click: the question's text, replacing a session's previous pop-up,
  and a click that routes to the right page. They belong to the signing task, when pop-ups can be
  checked.
- Chats in the number; a Dock menu; a sound; a phone push.
- Windows and Linux: there is no build for them.

## Documentation impact

- `kermanych/README.md` → «Desktop app (macOS)»:
  - the Dock number and the bounce;
  - the «Сповіщення» settings;
  - pop-ups need a signed build, so neither the dev `Electron.app` nor the unsigned dmg can show
    them.
- `kermanych/README.md` → the sidebar marks: a design's result counts as read once it is open in
  «Дизайн».
- Finding 893d0c31 is fixed here (decision 3). It can be dismissed once this lands.
