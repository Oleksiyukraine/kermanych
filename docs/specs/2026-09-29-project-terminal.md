# Integrated terminal per project

## Goal

Open a shell for a project from inside Kermanych, like the integrated terminal of VS Code
or JetBrains IDEs: a panel under the page, several tabs, the shell started in the
project's checkout, still alive when the operator switches project or reloads the UI.

## Context

- There is no terminal and no pty anywhere. The API spawns children with
  `node:child_process.spawn` only (`preview/preview.service.ts` is the lifecycle template).
- The API is always local (127.0.0.1): a separate `pnpm dev:api` process in the browser
  build, hosted inside the Electron main process in the desktop app.
- UI ↔ API: REST with the Supabase bearer (`lib/api.ts`), plus one socket.io channel
  (`ws/events.gateway.ts`) that only broadcasts and has no handshake auth.
- Shell layout (`layouts/MainLayout.vue`): `q-page-container > .shell__workarea` (page +
  file-manager dock), and a VS Code-style `q-footer` status bar with the dock toggles.
- A project's checkout on this machine is `Project.localRepoPath` (`""` when unbound).

## Decisions

- **Real pty: `node-pty` 1.1.0.** A shell over plain pipes has no job control, no
  line editing, no `vim`/`htop`. 1.1.0 ships N-API prebuilds for darwin and win32, so the
  same binary loads in plain Node (browser build) and in Electron without a rebuild — the
  better-sqlite3 arrangement. Its tarball ships `spawn-helper` without the exec bit
  (every spawn then fails with `posix_spawnp failed`), so the service restores the bit
  before the first spawn and the packaging step does it for the app bundle.
  Rejected: `child_process` + `script(1)` (no resize, macOS/Linux flags differ);
  1.2.0-beta (fixes the bit, but a beta).
- **Terminals live in the API, not in the socket.** A terminal survives a UI reload,
  a socket reconnect and a project switch; it ends when its shell exits, when the
  operator kills it, or when the API stops (`onModuleDestroy`). Each keeps the last
  256 KiB of output, replayed to whoever attaches, so a reloaded UI redraws the screen.
- **Transport: a `/terminal` socket.io namespace** (`ws/terminal.gateway.ts`). Output is
  streamed only to sockets attached to that terminal (a room per id); open/exit are
  broadcast so every window's tab list agrees. **The handshake must carry the same
  bearer the REST guard accepts** (`AuthService.acceptsToken`): a socket that can
  write to a shell is remote code execution for any local page otherwise, because the
  API allows CORS `*`. `KERMANYCH_PREVIEW=1` admits everyone, as the REST guard does.
  Rejected: Electron IPC — the browser build would get no terminal, and the pty would
  still have to live next to the API that knows the project paths.
- **Working directory: the project's checkout** (`localRepoPath`), resolved on the server
  from the project id; the client never sends a path. An unbound project, or a checkout
  that is gone from disk, is refused with a code the UI translates.
- **Shell: the user's login shell** — `$SHELL -l` (fallback `/bin/zsh` on macOS,
  `/bin/bash` elsewhere; `%COMSPEC%` on Windows). Login, because the desktop app started
  from Finder inherits launchd's minimal `PATH`. `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `TERM_PROGRAM=kermanych`, `LANG=en_US.UTF-8` when unset (a
  Finder-launched app has none, and Cyrillic paths then break). Removed from the
  inherited environment: `ELECTRON_*`, so an Electron CLI started from the shell does not
  run as Node, and `npm_*`, the lifecycle config `pnpm dev:api` exports, which otherwise
  steers every npm/pnpm run in the terminal (seen in the smoke run as a wall of
  `npm warn Unknown env config` from the shell profile).
- The pages sized themselves `calc(100vh - 90px)`; they now take `height: 100%` of the
  work area, so they shrink when the panel opens instead of running under it.
- **UI: a bottom panel under the page**, as in VS Code: tabs of the selected project's
  terminals, «+» for a new one, 🗑 to kill the active one, ✕ to hide the panel. Height is
  drag-resizable and persisted; visibility is persisted.
  - Toggle: a `>_` button in the footer status bar (next to the file-manager toggle — the
    footer already holds the panel toggles) and <kbd>Ctrl</kbd>+<kbd>`</kbd>, VS Code's
    binding, which also works from inside the terminal.
  - Opening the panel on a bound project with no terminal starts one; the shell exiting
    closes its tab; closing the last tab hides the panel.
  - Tabs belong to projects: switching project shows that project's terminals, the
    others keep running in the background.
  - Renderer: `@xterm/xterm` 6 + `@xterm/addon-fit`, colours read from the theme tokens and
    re-read on theme change.
- The width-only `useResizableWidth` becomes `useResizablePanel` with `edge:
  'left'|'right'|'top'|'bottom'` and a `size` result, so the panel reuses the
  pointer-capture, keyboard and persistence logic instead of a copy.

## Changes

- `packages/core/src/types.ts` — terminal wire types (`TerminalInfo`,
  `TerminalErrorCode`, `TerminalOpenReply`, `TerminalAttachReply`).
- `apps/api/src/terminal/terminal.service.ts` — pty lifecycle, scrollback, cwd/shell/env
  resolution, `spawn-helper` exec bit.
- `apps/api/src/ws/terminal.gateway.ts` — `/terminal` namespace, handshake auth, events
  `list`, `open`, `attach`, `detach`, `input`, `resize`, `kill` → `data`, `opened`, `exit`.
- `apps/api/src/auth/auth.service.ts` — `userForToken()`, the one bearer rule, used by the
  REST guard (`auth.guard.ts`) and the gateway handshake.
- `apps/api/src/app.module.ts` — registers the service and gateway.
- `apps/ui/src/lib/socket.ts` — exports the API origin; `lib/api.ts` — `getAuthToken()`.
- `apps/ui/src/stores/terminal.ts` — panel state, terminal list, socket client.
- `apps/ui/src/components/kit/KTerminalPanel.vue`, `KTerminalView.vue` — the panel.
- `apps/ui/src/layouts/MainLayout.vue` — footer toggle, panel placement, hotkey.
- `apps/ui/src/composables/useResizablePanel.ts` (renamed) — callers in `AgentsPage.vue`
  and `ChatPage.vue`.
- `AgentsPage`, `AiTeamPage`, `BoardPage`, `ChatPage`, `ManagementPage`, `SettingsPage` —
  root height `100%` of the work area instead of `calc(100vh - 90px)`.
- `apps/api/test/terminal.spec.ts` — the namespace end to end over a real socket and pty.
- i18n `terminal.*` and `common.nav.terminal` (uk/en).
- `package.json` (`onlyBuiltDependencies`), `apps/ui/quasar.config.ts` (`asarUnpack`,
  exec bit on the deployed `spawn-helper`).
- `kermanych/README.md` — the terminal section.

## Verification

- `apps/api`: `vitest run test/terminal.spec.ts` — 8 pass, over a real socket.io client and
  a real pty: a handshake without / with a foreign token is refused; the shell starts in
  the checkout (`pwd -P`); a second socket gets the replay while a non-attached one gets
  no stream; kill and `exit 3` reach every socket as `exit`; unbound / missing / unknown
  projects are refused with their codes; `appendReplay` bounds. Run once with
  `spawn-helper` reset to `644` — it passed and left the helper `755`.
- `apps/api`: `tsc --noEmit` clean; full `vitest run` — 782 pass, 2 fail in
  `rpc-session.compact.spec.ts` (RpcSession, untouched by this change).
- `apps/ui`: `vitest run` — 47 files, 533 pass; `vue-tsc --noEmit` — only the
  pre-existing `test/runtime-messages.spec.ts` TS2352. `packages/core`: 177 pass.
- Smoke, preview pair (api `KERMANYCH_PREVIEW=1 KERMANYCH_SEED=1`, ui
  `VITE_KERMANYCH_PREVIEW=1`) in headless Chromium:
  - `>_` on «Kermanych» opened the panel with `1: zsh`; `pwd && echo "привіт $((6*7))"
    && tput cols` printed `/tmp/kermanych-demo/kermanych`, `привіт 42`, `154`.
  - After an api restart the tab list emptied; «Новий термінал» and «+» made two tabs;
    `env | grep -c "^npm_"` printed `0`.
  - Switching to «Acme Web» showed its empty state, back to «Kermanych» showed both tabs;
    a page reload re-attached them with their output replayed.
  - <kbd>Ctrl</kbd>+<kbd>`</kbd> from inside the terminal hid and re-showed the panel;
    dragging the seam 150px up gave 430px (persisted), the page shrank to 380px and ended
    exactly at the panel's top (Агенти and Налаштування).
  - Light theme repainted the terminal; 🗑 on a middle tab left the other two; killing the
    last one hid the panel; a deleted checkout gave the «Теки проєкту більше немає» toast.
- Electron: node-pty spawned a shell under `ELECTRON_RUN_AS_NODE` of Electron 43.4.0;
  `pnpm build:app` built the dmg, the bundle had
  `app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` as
  `-rwxr-xr-x`, and requiring node-pty through `app.asar` spawned a shell.

## Documentation impact

`kermanych/README.md` — new «Integrated terminal» section; the native-module notes in
«Setup & run» and «Desktop app (macOS)» now cover `node-pty` and its `spawn-helper`.
