# Assistant overlay: the Менеджмент chat from anywhere in Kermanych

- **Branch:** `feature/add-global-chat-overlay`
- **Scope:** `apps/ui` only — the shell (`layouts/MainLayout.vue`), the Менеджмент page
  (`pages/ManagementPage.vue`, extraction only), new assistant components, a gesture
  recogniser, the «Загальне» and «Гарячі клавіші» settings panes, the session-browser key
  forwarding in `src-electron`, i18n `uk` / `en`, `kermanych/README.md`. No api, core or cloud
  change.
- **Status:** decisions agreed with the operator in the deep-analysis interview (2026-11-03),
  approved the same day; implemented on this branch (see «Verification»).

## Goal

The Менеджмент assistant (the chat docked at the foot of the Менеджмент tab) should be one
gesture away while the operator works anywhere else in Kermanych. Modelled on Eney: a
character peeks out of the window edge; clicking it opens the chat as an overlay in the centre
of the screen. Inside, the chat works exactly as it does on the Менеджмент tab. The Менеджмент
tab itself does not change.

## Context

- **The chat is one block of `ManagementPage.vue`** (template lines 89–245, script 374–593):
  transcript with the collapse toggle and «×» new chat, `kdoc:` citation clicks, pending
  attachments (`useFileAttach`), the composer with `/` helpers (`KHelperPicker`), 📎, the plan
  chip (`useSubscriptionUsage`) and the send disc, the «Думаю… N с» heartbeat. Draft,
  attachments and `collapsed` are component-local refs.
- **The conversation lives in `stores/management-chat.ts`**, keyed by
  `orchestrator.selectedWorkspaceId` (`byWorkspace`, `entries`, `busy`, `resetting`, `send`,
  `reset`). A turn in flight belongs to the store, so closing any view of it never aborts it.
  Two views of the store show the same transcript.
- **Workspace scope.** Selecting a project sets `selectedWorkspaceId` to its workspace
  (`stores/orchestrator.ts:343,365`); a local-only project has none. `send()` silently refuses
  without a workspace; the page shows the «pick a workspace» gate (`ManagementPage.vue:59-67`).
- **`section` matters only for documentation.** `send(text, section, files)` forwards the
  section to the api. Every digest (risks, roster, Jira, capacity, home) is sent regardless of
  section; only `management-docs` adds retrieval (`docsDigest`), a separate omp child
  (`childKey`) and `DOCS_MODEL` (`apps/api/src/management/management-chat.service.ts:81,243`).
- **Taken shortcuts:** ⌘\\ focus mode, ⌘B file manager, Ctrl+\` terminal (`MainLayout.vue`);
  ⌘D/⌘E/⌘./⌘⌫ on Агенти; ⌘L/⌘F in the session browser; ⌘S on Налаштування. ⌘K is free.
  The «Гарячі клавіші» pane lists shortcuts in `SettingsPage.vue` `KEYMAP`.
- **The session browser is a native view painted above the DOM.** It parks itself while any
  `[role="dialog"]`/`[aria-modal="true"]` is rendered (`composables/useOverlayOpen.ts`). Keys
  pressed inside it reach the renderer only through `before-input-event` →
  `bridge.onShortcut` (`src-electron/session-browser/browsers.ts:669,904`). Pointer moves over
  it never reach the renderer.
- **No mascot art exists.** The starting point is the logo mark: a `›` chevron and an `_` bar
  on a dark rounded square (`MainLayout.vue:128-132`, colours `#12110f`, `#ff563c`, `#f3f2f2`).

## Decisions

1. **Launcher: a character peeking from the left window edge (Eney style).** A small mascot
   built from the Kermanych logo (`›_` as its face), drawn as an SVG and polished before it
   ships: several variants are built, compared in the browser, and the operator approves
   screenshots. It sits at the left edge of the window near the bottom, above the sidebar,
   visible in focus mode too. Hover slides it out a little; click toggles the overlay. It
   carries state: a «thinking» animation while `chat.busy`, a dot when an answer landed while
   the overlay was closed (cleared on open).
   Rejected: a footer button next to `>_` (consistent but unnoticeable); a header button.
2. **Shortcut: ⌘K (Ctrl+K off macOS)**, matched by physical key (`KeyK`) so the Ukrainian
   layout works, active everywhere including while typing in a field. Pressing it again
   closes the overlay. Forwarded from the session browser through `before-input-event` like
   ⌘L/⌘F. Listed in «Гарячі клавіші». Rejected: ⌘J (less familiar), ⌘⇧Space (awkward), none.
3. **Gesture: a counter-clockwise circle with the mouse.** Recognised when the pointer sweeps
   ≥ 360° counter-clockwise around its own centroid within ≤ 1.2 s, at a mean radius of
   ~40–300 px, with no mouse button held (drags, text selection, resizing and canvas panning
   never count). Toggles the overlay, like ⌘K. A 1 s cooldown after a hit. Does not work over
   the session browser's native view (the renderer gets no pointer events there). A switch
   «Жест для виклику асистента» in Налаштування → «Загальне», on by default, stored on this
   machine like the theme — so it can be turned off if it misfires.
   Rejected: no gesture (operator wants to try it); a horizontal shake (operator chose the
   circle).
4. **Without a workspace the character is still there.** The overlay shows the same invitation
   as the Менеджмент tab: «pick a workspace», with its own line for a local-only project.
   Rejected: hiding the character; a disabled character with a tooltip.
5. **The overlay is a centred modal.** ~760 px wide, up to ~75 % of the window height, dimmed
   and blurred backdrop. Transcript on top (same header: collapse toggle, «×» new chat),
   composer at the bottom (`/`, 📎, plan chip, send). Closes on Esc (an open helper picker
   closes first), backdrop click, ⌘K, the character, or the circle. Closing during a turn is
   allowed: the turn continues, the character shows «thinking», then the dot. Draft, pending
   attachments and the collapse state survive closing and reopening (until the app restarts):
   the overlay is a lightweight `role="dialog" aria-modal="true"` element kept mounted and
   hidden with `v-show`, not a `QDialog` that unmounts its content — which also keeps the
   session browser parking correct, since a hidden element has no client rects. Focus moves
   to the field on open and returns to the previous element on close; the new-chat
   confirmation (`KConfirmDialog`) stacks above it.
   Rejected: a non-modal floating window (the session browser parks anyway, so the page under
   it is not really usable on Агенти); a draggable window (extra state for no gain).
6. **The overlay always sends as the «Огляд» section** (`MANAGEMENT_DEFAULT_SECTION`,
   `management-home`). The model gets the full workspace context; documentation retrieval
   stays on the Документація section. Rejected: the last Менеджмент section visited (behaviour
   depends on invisible history); a General/Docs switch in the overlay (new control, new
   state).
7. **On the Менеджмент tab the character is hidden** and ⌘K / the circle focus the tab's own
   composer (expanding a collapsed transcript) instead of opening the overlay. One chat on
   screen at a time; the tab looks exactly as today. Rejected: an overlay over the tab (two
   composers for one conversation); doing nothing there.
8. **Citations in the overlay behave as on the page.** The transcript is shared, so earlier
   Документація answers may carry `kdoc:` links; a click closes the overlay, navigates to
   Менеджмент → Документація and opens the file.

## Implementation

- **The chat is extracted** from `ManagementPage.vue` into
  `components/management/ManagementAssistant.vue` (props `section`, `variant: 'dock' | 'overlay'`;
  exposes `focus()`). The page renders it as the dock with unchanged geometry; the overlay renders
  the same component with denser glass (94 % surface instead of 74 %), because over a whole page
  the dock's frost let the page's text read through. Citation clicks route to Менеджмент →
  Документація; the launcher closes the overlay on entering Менеджмент, so no event is needed.
- **`stores/assistant-overlay.ts`**: `open`, `unread`, `summons`, `show()`, `close()`,
  `summon()`, plus the persisted `assistantGestureOn` switch. A summons is a counter: the
  Менеджмент dock (mounted only on that tab) focuses on it, the launcher toggles the overlay on it
  everywhere else — so ⌘K, the gesture, the character and the session browser never need to know
  which tab is on screen.
- **`components/assistant/AssistantMascot.vue`** — the SVG character: a glossy graphite drop lit
  warm from below by the accent, two white eyes with the logo's chevrons as pupils, the logo's bar
  as the mouth. It blinks; while a turn is in flight it breathes, its pupils read and the mouth
  blinks like a cursor; `prefers-reduced-motion` stills it. Chosen from seven drawn variants
  (a plain logo disc, the logo tile, double chevrons, and three refinements of the two-eyed drop).
  Later made a choice of characters (now ten), the drop among them
  (`docs/specs/2026-11-03-assistant-mascot-choice.md`).
- **`components/assistant/AssistantLauncher.vue`** — mounted once in `MainLayout.vue`: the
  character (fixed, left edge, z 5001 so it stays the overlay's toggle), the overlay (teleported,
  z 5000: above a full-screen session browser, below Quasar dialogs), the no-workspace gate, the
  unread mark, focus in and back, ⌘K (capture phase; Ctrl+K inside the terminal stays the
  shell's, as with Ctrl+\\), Esc (bubble phase, so the Хелпери panel keeps its own Esc), and the
  session browser's forwarded `assistant` shortcut.
- **`lib/circle-gesture.ts`** (the pure recogniser) and **`composables/useCircleGesture.ts`**
  (the window listener, mouse pointers only, 1 s cooldown).
- **Session browser:** `KeyK` → `assistant` in `MOD_SHORTCUTS` (`browsers.ts`), forwarded like
  `find`; `KermanychBrowserShortcut` gains `'assistant'`; `KBrowserPane.runShortcut` ignores it.
- Settings: the gesture switch in «Загальне»; ⌘K and the circle in `KEYMAP`. i18n `uk` / `en`.

## Verification

- `test/circle-gesture.spec.ts`: a counter-clockwise circle hits once and only after it closes;
  clockwise, unfinished, button held, too small, too large, too slow, two strokes split by a
  pause, a shake and a straight line do not; a hand-drawn ellipse does.
- Live preview (web build): character on Чат/Дошка/Налаштування, hidden on Менеджмент; click and
  ⌘K / Ctrl+K open and close the overlay; a turn sent from the overlay is answered in it; closing
  during a turn leaves the character «thinking», then the unread dot, cleared on reopening; the
  draft survives close/reopen and the field takes focus; Esc and a backdrop click close; while
  open the overlay counts as one visible `[role="dialog"]` (the session browser's parking signal),
  while closed as none; a synthetic counter-clockwise pointer path toggles it, and does nothing
  with the «Загальне» switch off; the no-workspace gate; on Менеджмент ⌘K unfolds and focuses the
  dock; dark and light themes.
- Менеджмент tab: the dock composer sits at the same box (562, 671, 680×52 in a 1280×800 window)
  before and after the extraction.
- Not exercised: the Electron build — ⌘K forwarded from inside a session browser page is covered
  by the typecheck only.

## Documentation

`kermanych/README.md` → «The Менеджмент tab and its assistant»: how to open the assistant from
anywhere (character, ⌘K, circle), the «Огляд» section rule, the gesture switch. The keymap pane
lists ⌘K.
