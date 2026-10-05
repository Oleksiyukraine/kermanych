# Session browser: an embedded browser the operator and the agent share

## Goal

Competitors (Orca, BridgeMind) embed a browser next to the agents. Two problems it solves,
as the operator put it (session `add-internal-browser`, 2026-10-05):

1. The agent has direct access to a browser — the same page the operator sees, not a
   separate headless Chrome.
2. The operator can point at the problem live: click an element on the page and hand it to
   the agent with its DOM, styles and a screenshot (Orca's «Design Mode»).

The operator has no final picture of how it should work and expects to try it and rework
it. This is the first iteration: small enough to throw away, real enough to judge.

## Context

- One Electron `BrowserWindow` (`apps/ui/src-electron/electron-main.ts`); the NestJS api runs
  in the same main process (`bootstrap()`); `external-links.ts` sends every link to the
  system browser. No `<webview>`, no `WebContentsView` before this change.
- Live preview per session already exists (`apps/api/src/preview/preview.service.ts`): the
  ▶ button starts the project's preview command in the session worktree and opens the URL in
  the system browser (`togglePreview` in `apps/ui/src/pages/AgentsPage.vue`).
- Agents: managed (`omp --mode rpc` / Claude Agent SDK, accept images) and native (the
  harness TUI in a pty, text only — `docs/specs/2026-10-05-native-sessions.md`).
- One MCP precedent: the Менеджмент chat's Jira tools (`management-mcp.service.ts`), handed
  to claude via SDK `mcpServers` and to omp via the `omp-mcp-bridge.ts` extension.

## Decisions

- **One `WebContentsView` per session**, created on first use (operator opens the tab, or the
  agent calls a browser tool). Partition `persist:kermanych-browser-<projectId>`: sessions of
  one project share cookies/logins, projects do not. `sandbox`, `contextIsolation`, no
  preload, no node. Permission requests denied except clipboard write and fullscreen.
  Popups (`target=_blank`, `window.open`) load in the same view; only http(s) and
  `about:blank` navigate.
  - Rejected: `<webview>` (Electron discourages it, needs `webviewTag` on the app window);
    iframe (frame-busting headers, no CDP); `--remote-debugging-port` + chrome-devtools-mcp
    (exposes the app's own renderer, tokens included, to every local process).
- **Shown view vs parked views.** The renderer reports the placeholder's bounds; main
  positions that session's view there. Every other view is *parked*: still attached, with
  all but one pixel past the window's bottom-right corner. Probed on Electron 43 (this
  machine): a detached view does not lay out (CDP clicks miss) and cannot be captured; a
  `setVisible(false)` view takes input but `Page.captureScreenshot` times out or not at
  random; a view fully outside the window times out; a view with one pixel inside renders
  and captures reliably (5/5, full frame). So an agent can work in a session the operator
  is not looking at, and screenshots still work.
- **The native view sits above the DOM**: menus and modals cannot cover it. The renderer
  parks it whenever an overlay is open, the tab is not Браузер, or the page unmounts.
- **Agent access: MCP over the local api.** `POST /api/browser/mcp` (Streamable HTTP, JSON
  responses, the four methods of the management server) with a per-session bearer; the
  tools act on that session's view only. Tools: `browser_navigate` (no URL → the session's
  running preview), `browser_snapshot` (text outline with `e<N>` refs), `browser_click`,
  `browser_type`, `browser_press`, `browser_screenshot` (image content), `browser_console`
  (console + failed / 4xx / 5xx requests), `browser_evaluate`. Server name `kermanych` →
  claude shows `mcp__kermanych__browser_*`, omp the bare names.
  - Input goes through CDP (`Input.dispatchMouseEvent`, `Input.insertText`,
    `Input.dispatchKeyEvent`) on the view's `webContents.debugger`, so frameworks see real
    events; snapshot/refs and the picker are injected scripts.
  - Rejected for now: a Kermanych CLI (Orca's way) — MCP already reaches both runtimes.
- **Who gets the tools**: managed agent and chat sessions (launch and resume), and — a
  deliberate exception to the native-sessions rule «nothing of Kermanych enters the agent's
  context» — native sessions too: claude via `--mcp-config <per-session 0600 file>`, omp via
  `--hook <omp-mcp-bridge>` with the URL and bearer in its environment. Without it the
  operator could not try point 1 with native sessions at all. Discussion/review forks do
  not get them. Without a browser host (standalone api) nobody does.
- **Picking (point 2).** «Вказати» injects a picker into the page (main world, so it can read
  Vue `__vueParentComponent.type.__file`, React `_debugSource`, Svelte `__svelte_meta`);
  the clicked element's selector, trimmed outerHTML, curated computed styles, rect and
  component source come back with a cropped CDP screenshot, also written to
  `$TMPDIR/kermanych-browser/<sessionId>/`. Picks gather in a tray under the toolbar, each
  with the operator's comment; «Надіслати агенту» sends one message through the normal
  message path. Managed sessions get the crops as images; native ones get the file paths
  (they accept text only, and only while idle — a busy refusal keeps the tray).
- **Preview opens in the session browser** in the desktop app (the ▶ button switches to the
  Браузер tab); the toolbar keeps «open in system browser». The web build is unchanged.

## Changes

- `apps/api`: `browser/browser-host.ts` (the host contract, set by `bootstrap({ browser })`),
  `browser/browser-mcp.service.ts` + `http/browser-mcp.controller.ts`, supervisor and native
  launch wiring, `omp-mcp-bridge.ts` passes image content through.
- `apps/ui/src-electron`: `session-browser.ts` (views, parking, CDP actions, snapshot,
  picker, IPC), `electron-main.ts` passes it to `bootstrap`, preload exposes
  `window.kermanych.browser`.
- `apps/ui`: `components/kit/KBrowserPane.vue` (toolbar, placeholder, picks tray),
  `stores/browser.ts` (state per session, picks), `composables/useOverlayOpen.ts` (parks
  the view while any `[role=dialog|menu|listbox]`, `[aria-modal]` or error toast is on
  screen), `lib/browser-picks.ts` (the message), Браузер tab + preview routing in
  `pages/AgentsPage.vue`, a live dot in `KTabs.vue`, i18n uk/en.
- `kermanych/README.md` — «Session browser» section; «Desktop app» and «Native sessions»
  sentences.

## Verification

- Electron 43 probes (throwaway, this machine) behind the parking decision: see Decisions.
- `apps/api`: `tsc --noEmit` clean; full `vitest run` — all pass except the same 2
  `rpc-session.compact.spec.ts` failures as on `dev`. New `test/browser-mcp.spec.ts` (bearer
  and binding, tools/list, routing to the host with the session's project, navigate →
  preview URL / error, host failure → tool error, a session's parallel calls run in order);
  `native-session.spec.ts` covers the claude `--mcp-config` file (0600) and the omp second
  `--hook` + env. Real claude 2.1.206: a `-p` run with the generated `--mcp-config` called
  `browser_evaluate` against the real service.
- `apps/ui`: `vue-tsc` — only the pre-existing `test/runtime-messages.spec.ts` TS2352;
  `vitest run` all pass (incl. `browser-picks.spec.ts`, i18n completeness).
- The host's injected scripts were run in a real Electron view (snapshot outline, click by
  ref, type/submit, keys, console + 404, evaluate, picker result and crop, parked-view
  screenshot, re-park on resize).
- End to end, `pnpm dev:app` in preview mode (`KERMANYCH_PREVIEW=1`, isolated DB), a demo
  git repo served on `127.0.0.1:8765`, a managed omp chat:
  - The agent called `browser_navigate`, `browser_snapshot`, `browser_click`,
    `browser_type`, `browser_console`, `browser_screenshot`, `browser_evaluate`; the page
    showed the click result and the typed text; its answer named the console error, the
    404 and the page's missing charset. A snapshot it fired in parallel with the navigate
    failed — hence the per-session queue in `BrowserMcpService`.
  - The Браузер tab placed the view exactly over the placeholder (`624,193 364×660` on both
    sides); opening the ⋯ menu parked it (`1399,899`), closing it restored the view.
  - «◎ Вказати» + a click on the page's button: the click did not reach the page, the tray
    showed the crop and `#card > button`; with a comment, «Надіслати агенту» delivered one
    message (comment, URL, selector, styles, HTML) with 1 image and switched to Лог. The
    picked HTML carried the snapshot's `data-kermanych-ref` — now stripped.
  - After an app restart, a message to the stopped chat resumed it with the tools; with the
    Лог tab open (view parked, never shown, `1280×800`) `browser_navigate` +
    `browser_screenshot` worked and the agent read the page from the image.
  - Picking on the app's own Vite dev UI gave the component file
    (`…/src/components/kit/KNavItem.vue`).
- Not exercised end to end: ▶ preview routing into the tab (preview mode has no cloud to
  store a preview command) and native sessions inside the app (they need a cloud task).

## Documentation impact

`kermanych/README.md` — new «Session browser» section; «Desktop app» now says the live
preview opens in the session browser; «Native sessions» names the browser tools as the one
exception to «nothing of Kermanych enters the agent's context».
