# Session browser, second iteration: fixes, agent tools, layout

## Goal

The first iteration (`docs/specs/2026-10-05-embedded-browser.md`) was meant to be tried and
reworked. A review of it (session `refactoring/browser`, 2026-10-07/08) — code read plus the
reviewer driving the browser through its own MCP tools — found these problems, and the operator
asked for all of them to be fixed:

- An agent's `browser_navigate` took keyboard focus from the app: the operator's typing in the
  «Нова задача» modal went into the page (happened live during the review).
- `browser_click` clicked whatever covered its target and reported success.
- `confirm()` returned `false` at once and unseen; `window.open` replaced the page and returned
  `null` (OAuth popups broken); a native `<select>` could not be operated; `mailto:` did nothing;
  hover-only menus were out of reach; ⌘R / ⌘W reached the app menu (reload / close the window).
- The browser was a tab, so the operator could not watch the Лог and the page at once; any
  menu, dialog or error toast blanked the page; info toasts sat under it; picking shifted the
  page; no load/error state; the agent's viewport was whatever the pane last was.
- Views lived until the session was deleted; crashes, temp files and stale renderer state were
  not handled; `session-browser.ts` was one 1080-line file with no tests.

## Decisions

- **Module split** (`apps/ui/src-electron/session-browser/`): `browsers.ts` (views, parking,
  focus, shortcuts, popups, dialogs, auth/cert/downloads/UA, crash, eviction, viewport, pause,
  find, IPC), `actions.ts` (the agent's tools), `scripts.ts` (injected page scripts), `keys.ts`,
  `cdp.ts`, `view.ts` (per-session state). `apps/ui/src/lib/browser-url.ts` is the one URL
  policy for main and the address bar (bare local host → http, other bare host → https, words →
  web search).
- **Focus guard.** Probed: `loadURL` (and reload/back/forward) gives the view focus, parked or
  not. Agent and popup loads set a suppression window; a `focus` the view takes inside it is
  handed back to the app's webContents. CDP mouse events emit `before-mouse-event` too, so an
  operator click lifts the guard only when no agent call is in flight. The address bar's own
  load focuses the page only when the view is the shown one (as in Chrome).
- **Dialogs through Electron's `-run-dialog`, not CDP.** Probed: with CDP `Page.enable` the
  dialog is interceptable, but Electron's default handler also pops a window-modal native
  message box that stays on screen after CDP answers; `disableDialogs` suppresses the dialog
  before CDP sees it. So each view replaces the internal `-run-dialog` listener: the dialog goes
  into the state (a bar in the pane) and into the agent's action result, and whoever answers
  first calls Electron's callback. `-cancel-dialogs` clears it; `will-prevent-unload` is always
  prevented («Leave site?» would otherwise silently block navigation). `prompt()` throws in
  Electron's renderer, so the contract has `alert` and `confirm` only. Input actions race the
  dialog (the triggering CDP call stays pending until it is answered) and return early.
- **Popups.** `window.open` with features (`disposition: new-window`) is allowed as a child
  window of the app with the opener kept (probed: `opener=true`); the agent is told it opened and
  that it is the operator's. `target=_blank` loads in the same view. `mailto:`/`tel:` go to the
  OS only from the operator's own click on the shown view.
- **Viewport.** Zoom is shared by every view of an origin in a partition (probed), so it is not
  used. A width narrower than the pane sizes the view; a wider one uses
  `webContents.enableDeviceEmulation` (per webContents, page laid out at that width, drawn scaled;
  CDP input coordinates × scale; re-applied after every cross-document navigation, which drops
  it). Parked views take the exact requested size. Operator presets and the agent's
  `browser_resize` share it.
- **Hit-tested input.** Click/hover/select pick a visible point whose `elementFromPoint` is the
  target (through shadow roots and same-origin frames), re-checked after the pointer moves, and
  refuse with the covering element otherwise. Snapshot refs live in a main-world
  `Map<ref, WeakRef>` instead of DOM attributes; same-origin iframes are walked.
- **New agent tools:** `browser_hover`, `browser_select`, `browser_history`,
  `browser_wait_for`, `browser_resize`, `browser_upload`, `browser_dialog`, `browser_network`;
  `browser_screenshot` gains `full_page` / `ref` and answers in CSS pixels. `browser_dialog`,
  `browser_console` and `browser_network` bypass the per-session queue.
- **Operator UI.** Split mode («Поруч із логом», resizable seam, the Браузер tab hidden);
  freeze-frame (`capturePage` just before parking) while an overlay is open; toasts placed
  beside the shown view, so error toasts no longer park it; progress line, ✕ stop, error/crash
  panel, dialog bar, HTTP sign-in modal, find bar, viewport chip with scale, agent pause toggle,
  `</>` devtools, ◎ marker on board cards; the picker's hint is inside the page (no layout
  shift), Shift-click keeps picking, picks carry viewport/scroll/frame, a general comment, ⌘↵
  sends, the tray persists in `sessionStorage`. A narrow pane wraps the toolbar into two rows
  (container query).
- **Lifecycle.** At most 6 live views (LRU; never the shown one, one with a dialog/auth/pick,
  or one the agent used in the last 2 minutes), idle views close after 20 minutes; the last URL
  per session persists in `userData/session-browser.json` and the empty pane offers «Відкрити
  знову»; crashes are reported and recovered by navigate/reload; deleting a session removes its
  temp crops; crops older than 7 days are swept at start. Downloads go to the OS Downloads
  folder; the UA drops `Electron/`; self-signed certificates are accepted for local hosts only.

## Changes

- `apps/ui/src-electron/session-browser/*` (replaces `session-browser.ts`),
  `electron-preload.ts` (full bridge), `src/types/kermanych-bridge.d.ts`.
- `apps/api/src/browser/browser-host.ts` (contract), `browser-mcp.service.ts` (tools),
  `main.ts` (type re-exports), `test/browser-mcp.spec.ts`.
- `apps/ui/src`: `components/kit/KBrowserPane.vue`, `KToast.vue`, `KSessionCard.vue`,
  `stores/browser.ts`, `composables/useOverlayOpen.ts`, `lib/browser-picks.ts`,
  `lib/browser-url.ts`, `pages/AgentsPage.vue`, i18n uk/en; tests `browser-picks.spec.ts`,
  `browser-url.spec.ts`, `session-browser-keys.spec.ts`.
- `kermanych/README.md` — «Session browser» rewritten.

## Verification

- Throwaway Electron 43.4.0 probes behind each decision above (focus on load, dialogs with
  CDP vs `-run-dialog`, `disableDialogs`, popups, zoom sharing, device emulation and input
  scaling, `before-input-event` vs the menu, HTTP auth, downloads, crash recovery, find).
- `apps/api`: `tsc --noEmit`; `vitest run` — all pass except the same 2
  `rpc-session.compact.spec.ts` failures as on `dev`. `apps/ui`: `vue-tsc` — only the
  pre-existing `test/runtime-messages.spec.ts` TS2352; `vitest run` — all tests pass; 10 spec
  files fail to collect on Node 25 (`localStorage.getItem is not a function`), as before.
- In the real app (`quasar dev -m electron`, preview mode, isolated DB, seeded), driven over
  CDP with the agent's calls made on the real `BrowserHost` from the main-process inspector,
  against a local fixture page:
  - covered-button click refused naming `<div#cover>`; `browser_select` by label fired
    `change`; a click inside a same-origin iframe landed; hover revealed a `:hover` menu in the
    next snapshot; typing, upload (relative path refused), `wait_for` hit and timeout;
  - an agent click on `confirm()` returned at once with the dialog; snapshot refused while it
    was open; the pane showed the bar; answered by the operator's OK and by `browser_dialog` —
    no native message box;
  - `window.open` opened a 420×300 child window and the page logged `opener got window`; an
    agent `mailto:` click was blocked and logged; a download landed in Downloads and was logged;
    the network log listed document, frame and the 404 fetch;
  - viewport 1280 on a 763 px pane: `innerWidth` 1280, scale 60 %, a click at that scale landed;
    390 sized the view; `browser_resize` and reset; screenshots 1280 px wide (viewport/full
    page) and element-sized for a ref;
  - an open menu replaced the page with the still frame; a failed load showed the panel and no
    toast; split mode hid the Браузер tab and placed the pane beside the Лог with the two-row
    toolbar; Shift-click picked two elements (one inside the iframe) into the tray; pause made
    the agent's tools refuse; find highlighted 1/1; a toast sat left of the view; sending picks
    to a seeded session (no worktree) kept the tray and showed the error;
  - focus: with the app window focused and the address field active, an agent
    `browser_navigate` left the app's webContents focused and the view unfocused.
- Not exercised in the app: native sessions, the HTTP sign-in modal (probed on the main side
  only), certificate errors, eviction/idle timers, temp sweep, ⌘-shortcuts typed inside the
  page.

## Documentation impact

`kermanych/README.md` — «Session browser» rewritten for the new layout, tools and behaviour.
