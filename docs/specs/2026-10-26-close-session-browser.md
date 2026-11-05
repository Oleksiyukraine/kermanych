# Closing the session browser by hand

## Goal

The operator asked whether the session browser can be closed at all, and then asked for a
✕ right on the «Браузер» tab, beside its label.

## Context

- One `WebContentsView` per session lives in Electron main
  (`apps/ui/src-electron/session-browser/browsers.ts`). It closed only by itself: the LRU cap of
  6 live views (`evictForNewView`), 20 idle minutes (`closeIdle`), a deleted session
  (`close`, from `supervisor.service.ts`) or a dead page. `teardown(sessionId)` already closes
  the view, keeps the last URL and tells the renderer (`kermanych:browser:closed`). The empty
  pane then offers «Відкрити знову».
- The renderer had no IPC to close a view. The «Браузер» tab (`AgentsPage.vue`, `detailTabs`)
  is a plain `KTabs` tab.

## Decisions

- **✕ is a `KTabs` feature**: a tab with `closeLabel` gets a ✕ and emits `close` with its
  value. The ✕ is a sibling button of the tab, not a child, because a button inside a button
  is invalid. The underline moved from the tab button to a new `.k-tabs__item` wrapper, so it
  runs under the ✕ as well; tabs without a ✕ look the same as before.
- **Shown only while a page is open** (`sessionBrowser.states[id]`): on an empty tab it would
  do nothing.
- **The tab stays, and so does the selection.** Closing frees the page, not the tab (it is
  always present). If the operator is on the tab, it shows «Відкрити знову» with the last
  address. Pressing ✕ from another tab does not switch to it.
- **Close = `teardown`**: the last URL survives, as after an idle close. The picks tray stays
  too. An in-flight pick resolves empty, and the find bar closes with the page.
- **A closed view no longer reports state.** `emit` drops reports from a view that is not in
  the map anymore. Without this, a load stopping on its way out (close during a reload) would
  bring the state back in the renderer, and the pane would recreate the view.
- Beside the Лог («Поруч із логом») there is no Браузер tab, so there is no ✕ there. Not
  asked for.

## Changes

- `apps/ui/src-electron/session-browser/browsers.ts`: `kermanych:browser:close` IPC →
  `teardown`; `emit` guard.
- `apps/ui/src-electron/electron-preload.ts`, `src/types/kermanych-bridge.d.ts`:
  `browser.close(sessionId)`.
- `apps/ui/src/stores/browser.ts`: `close(sessionId)`.
- `apps/ui/src/components/kit/KTabs.vue`: `closeLabel` per tab, `close` event, the
  `.k-tabs__item` wrapper.
- `apps/ui/src/pages/AgentsPage.vue`: `closeLabel` on the Браузер tab while a page is open,
  `onDetailTabClose`.
- `apps/ui/src/components/kit/KBrowserPane.vue`: the find bar closes when the view goes.
- i18n `agents.browser.close` (uk, en).

## Verification

- `pnpm typecheck` (`apps/ui`): only the pre-existing `test/runtime-messages.spec.ts` TS2352.
- `vitest run` (`apps/ui`): 63 files, 717 tests pass.
- Electron dev app (`quasar dev -m electron`, throwaway `KERMANYCH_DB` + `KERMANYCH_SEED`,
  preview mode), driven over CDP, session `refactoring/store`, a local page on
  `127.0.0.1:8765`:
  - With no page, the tab had no ✕. After loading the page, «Браузер ✕» showed, with the
    accent underline under both (screenshot).
  - A real mouse click on ✕: `browser.state()` returned `null` and the view was gone. The tab
    stayed active, without its ✕, and the pane showed «Відкрити знову» with
    `http://127.0.0.1:8765/`. `lastUrl()` returned the same address.
  - «Відкрити знову» loaded the page again, and the ✕ came back.
  - `reload` followed at once by `close`: after 2.5 s both main and the renderer still had no
    state and no view, so the guard holds.
  - ✕ pressed while on Лог: Лог stayed active, and the page was closed.

## Documentation impact

`kermanych/README.md` «Session browser» describes the ✕ on the tab and what happens to the
agent's tools after a close.
