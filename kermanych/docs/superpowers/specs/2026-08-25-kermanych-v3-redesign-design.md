# Kermanych v3 redesign — design system, UI-kit, UX/UI — design

Date: 2026-08-25
Status: approved (design; implementation plan pending)

## Problem

Client feedback prompted a full visual redesign. The reference is
`design/kermanych-v3.html` (a self-contained bundler export; the real markup
lives in its `__bundler/template`, and it renders three interactive screens when
opened in a browser).

The current look and the v3 reference diverge on three layers:

- **Design system.** `packages/tokens` is minimal — 7 colors, 2 fonts, 2 rules
  (`packages/tokens/src/tokens.css`, `index.ts`). Its palette is a *warm*
  brown-black (`--k-canvas:#12110f`, `--k-surface:#232120`) and its UI face is
  Archivo (`fonts.css` imports `@fontsource/archivo`). v3 is a *cool* neutral
  near-black (`#050505` / `#141414` / `#1c1c1c`) on the **system** UI font, with
  a fuller token set (three surface levels, three text tiers, four status
  colors, a radius scale, spacing). The brand accent is unchanged: `#ff563c`.
- **UI-kit.** 24 `K*` components exist (`apps/ui/src/components/kit`). They carry
  the old palette and, in places, an explicit "radius 0, hairline"
  design-system rule (`KTable.vue`, `KitGalleryPage.vue` lede) that v3 replaces
  with rounded surfaces (8/12px) on flat elevation.
- **UX/UI.** The shell today is a narrow project rail + top header + footer
  status bar (`apps/ui/src/layouts/MainLayout.vue`), with in-page view toggles
  (`WorkspacePage.vue` `VIEW_ACTIVE|VIEW_TASKS|VIEW_ARCHIVED`) and a separate
  team board (`BoardPage.vue`). v3 reorganizes this into a top-bar segmented
  navigation (**Агенти / Дошка / Чат**) over a three-pane Agents view, a Kanban
  team board, and a standalone Chat.

Not every v3 element has a backend. Some are explicitly out of scope (costs and
tokens in the sidebar). The redesign must map v3 onto real functionality rather
than reproduce dead controls.

## Approach

**Hybrid fidelity, bottom-up, gallery-gated** (both chosen with the operator):

- The **design system (tokens)** and **UI-kit (K\* components)** are reproduced
  faithfully from v3 — the values below are extracted from the rendered bundle,
  not eyeballed.
- The **screens/UX** follow v3's information architecture but adapt to real
  functionality: elements with no backend are skipped or shown as read-only
  indicators, decided per element (see Build/skip).
- Work proceeds **bottom-up**: tokens → UI-kit (reviewed in the existing
  `KitGalleryPage`) → screens (one at a time, reviewed live). The visual
  language is locked in the gallery before any screen changes.

Clean cutover: the redesign replaces the current tokens and restyles the
existing components in place. No parallel "v3" theme, no dead old styles left
behind.

## Design system

Rewrite `packages/tokens/src/tokens.css` (CSS custom properties) with a mirrored
TS surface in `index.ts`, and update `apps/ui/src/css/app.scss` +
`apps/ui/src/css/quasar.variables.scss`. Drop `@fontsource/archivo` from
`fonts.css`; keep `@fontsource/jetbrains-mono`.

**Color** (extracted from v3):

| token | value | role |
|---|---|---|
| `--k-canvas` | `#050505` | app background |
| `--k-bg` | `#141414` | panels |
| `--k-surface` | `#1c1c1c` | cards / elevated |
| `--k-surface2` | `#2b2b2b` | inputs / hover |
| `--k-line` | `rgba(255,255,255,.08)` | hairline border |
| `--k-line-strong` | `rgba(255,255,255,.14)` | strong border |
| `--k-text` | `#ededed` | primary text |
| `--k-muted` | `#8a8a8a` | secondary text |
| `--k-faint` | `#6b6b6b` | tertiary/meta text |
| `--k-on-accent` | `#0a0a0a` | text on accent fills |
| `--k-accent` | `#ff563c` | brand / CTA / active (unchanged) |
| `--k-accent-hover` | `#ff6a52` | accent hover |
| `--k-success` | `#28c840` | done / merged |
| `--k-warning` | `#febc2e` | waiting |
| `--k-danger` | `#ff5f57` | error / conflict |
| `--k-diff-add` | `#28c840` | added lines |
| `--k-diff-del` | `#ff5f57` | removed lines |

`--k-accent` also signals *running* (matches KStatusDot's running kind and
KPanel's active top strip).

**Themes.** The sheet ships two sets: the dark values above in `:root`, and a
light set under `:root[data-theme='light']`. `apps/ui/src/lib/theme.ts` writes
the attribute and persists the choice (`localStorage` key `kermanych.theme`,
default `dark`); `boot/tokens.ts` applies it before mount, so a light-theme user
never sees the dark default flash. The toggle is the top bar's rightmost icon
(`☀`/`☾`, naming the theme it moves to). Colours only — type, radii, spacing and
rules are shared.

| token | light value | note |
|---|---|---|
| `--k-canvas` | `#f6f6f7` | grey page |
| `--k-bg` | `#fbfbfc` | panels |
| `--k-surface` | `#ffffff` | cards |
| `--k-surface2` | `#ebebec` | hover / selected / table head |
| `--k-line` / `--k-line-strong` | `rgba(0,0,0,.12)` / `rgba(0,0,0,.18)` | black alpha reads weaker than white alpha |
| `--k-text` / `--k-muted` / `--k-faint` | `#141416` / `#63636a` / `#8b8b93` | |
| `--k-accent` / `--k-accent-hover` | `#c8351b` / `#a82a13` | retuned; hover darkens here |
| `--k-on-accent` | `#ffffff` | |
| `--k-success` / `--k-warning` / `--k-danger` | `#0f7a24` / `#8a5d00` / `#c0271f` | |
| `--k-shadow-pop` / `-toast` / `-modal` | `.10` / `.14` / `.18` black alpha | dark set uses `.35` / `.5` / `.6` |

Two deliberate departures from the dark set:

1. **The surface ladder is not monotonic.** `canvas → bg → surface` still goes
   recede → raise, but `--k-surface2` reads *darker* than the canvas, because
   nothing is lighter than `#ffffff`. Read the invariant as "distance from the
   canvas grows", not "lightness grows".
2. **The brand accent is retuned, not reused.** `#ff563c` is 3.2:1 on white and
   is used as TEXT in ~37 places, so the light set uses `#c8351b` (5.3:1) with a
   white `--k-on-accent` to keep accent FILLS legible. Every light foreground
   clears WCAG AA against `--k-surface`; `--k-faint` stays decorative at 3.4:1,
   as it is in the dark set.

**Type**

- UI: `--k-font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
  (v3 drops Archivo).
- Mono: `--k-font-mono: 'JetBrains Mono', ui-monospace, monospace`.
- Scale (px): `--k-fs-xs:11` (meta/counts) · `--k-fs-sm:12` · `--k-fs-base:13`
  (UI default) · `--k-fs-md:15` (titles/logo) · `--k-fs-lg:18` (screen headers).
- Weights: 400 / 500 / 600.

**Radii:** `--k-r-sm:6` · `--k-r:8` · `--k-r-lg:12` (cards/panels) ·
`--k-r-pill:999px` · dots `50%`.

**Spacing (px):** `--k-sp-1:4` · `2:8` · `3:12` · `4:16` · `5:20` · `6:24` · `7:32`.

**Elevation:** flat — depth via surface levels + 1px borders. Shadows reserved
for floating surfaces only: chat composer, send FAB, modals, dropdowns, toasts.

**Rules (kept):** `--k-rule-thin:1px`, `--k-rule-strong:2px`.

Review: a "Foundations" panel added to `KitGalleryPage` (swatches, type scale,
radii) for visual sign-off.

## UI-kit

Reviewed end-to-end in `apps/ui/src/pages/KitGalleryPage.vue` with states
(default / hover / active / disabled / loading) before any screen changes.

**Restyle in place** (existing `K*` → v3 tokens):

- Controls: `KBtn` `KIconButton` `KToggle` `KCheckbox` `KSelect` `KField`
  `KColorPicker` `KDirPicker`
- Status/labels: `KStatusDot` `KTag` `KStatusRow`
- Transcript: `KToolRow` `KToolCard` `KLogBlock` `KTodoLane` `KRequestBlock`
- Shell/overlays: `KModal` `KToast` `KUserButton` `KAttachStrip` `KEnvEditor`
- Composite: `KPanel` (session detail) `KRailItem` (project item)

**New primitives** (required by v3):

- `KTopNav` — segmented top navigation (Агенти / Дошка / Чат).
- `KNavItem` + `KCount` — sidebar entries with count badges.
- `KSessionCard` — Agents middle-column list item (branch + title + time +
  status line), fed by `WorkspacePage` `boardRows`.
- `KKanbanColumn` + `KKanbanCard` — team board.
- `KComposer` — extracted from `KPanel` "floor 3" composer
  (`KPanel.vue:157-217`); shared by the Agents detail and Chat. Attachment strip
  + input + selects (model / worktree / token count) + send FAB.
- `KChatMessage` + `KThoughtToggle` — Chat + transcript (user bubble,
  `Думав Nс ▸` collapsible).
- `KTabs` — Лог / Зміни / Сесія (may reuse the `KTopNav` segmented style).

**Decisions:**

1. `KTable`'s session-board role is retired → `KSessionCard` list (Agents) +
   Kanban (Board). `KTable` is kept only if a genuinely tabular use survives
   (verify `KTable` usages during implementation; `KitGalleryPage` demoes it).
2. Extract `KComposer` from `KPanel` (shared with Chat).
3. `KStatusBar` (footer fleet aggregate) is retired — the sidebar's
   `KNavItem`+`KCount` convey fleet state. `KStatusRow`'s session status
   line moves into `KSessionCard`.

`KThemeToggle` is **not** built (see Out of scope).

## Screens

The IA follows v3; each screen maps onto real functionality.

### Shell (MainLayout)

Replace the `q-drawer` rail + `q-header` + `q-footer` shell with: a top bar
(logo + `KTopNav` segmented Агенти/Дошка/Чат + window/settings controls) and a
persistent left sidebar. The footer status bar is dropped — the sidebar's
per-bucket counts (`KNavItem`+`KCount`) convey fleet state.

Left sidebar (all screens):

- Navigation (`KNavItem` + `KCount`): **Активні** / **Задачі** / **Відкладені** /
  **Історія**.
  - Активні, Задачі, Відкладені map 1:1 to today's `WorkspacePage` view modes
    (`VIEW_ACTIVE|VIEW_TASKS|VIEW_ARCHIVED`, `WorkspacePage.vue:549-557`) but
    **Активні narrows to live sessions** (`queued|thinking|tool|waiting_input`).
  - **Історія** is new: completed sessions (`merged|done|stopped`). Add a
    `VIEW_HISTORY` bucket; completed agents move here from Активні.
- **Проєкти** — cloud project list + `+` (create in cloud), each with a binding
  status dot (existing `KRailItem` model).
- **Тека проєкту** + «Змінити теку» — this machine's binding
  (`api.setProjectBinding`, `KDirPicker`).
- User chip (auth) at the bottom.

Skipped in the sidebar: **Витрати / Токени** (no backend) and the **PRO** badge
(no subscription tiers). The theme toggle lives in the top bar, not the sidebar.

### Агенти (three-pane)

- **Left:** the shared sidebar.
- **Middle:** session list of `KSessionCard`, sourced from `boardRows`
  (`WorkspacePage.vue:592`), filtered by the active sidebar bucket. Header shows
  the bucket label + count + collapse.
- **Right:** `KPanel` session detail with `KTabs`:
  - **Лог** — the transcript (existing `KLogBlock`/`KToolRow`/`KToolCard`).
  - **Зміни** — a summary from `api.finishInfo`
    (`{branch,target,ahead,dirty,conflicts}`, `api.ts:204-207`) plus a
    changed-files list. `finishInfo` (or a sibling endpoint) is extended to
    return changed files via `git diff --numstat` (path + `+/−`). No full
    file-diff viewer (see Out of scope).
  - **Сесія** — session metadata + actions built from existing data/routes:
    model, branch, worktree, base; finish / review / pr / archive
    (`api.finishInfo/finish/reviewSession/createPr/mergeBranch/archiveSession`).
  - `KComposer`: model + worktree + token count wired to existing state
    (`session.model`, `contextPercent`). Reasoning and "Авто-правки" selects are
    wired **only if** a direct omp RPC exists (verify against omp during Phase
    3); otherwise display-only or omitted, per the Hybrid rule.

### Дошка (team board)

Restyle `BoardPage.vue` (+ `useBoard` store) into a Kanban:

- Columns map to `TaskStatus`: **Беклог** (`backlog`) / **У черзі** (`queued`) /
  **В роботі** (`thinking|tool`) / **Чекає** (`waiting_input`) / **Завершені**
  (`done|merged`). Errored/stopped map to **Чекає** (needs attention).
- Header: «Дошка команди» + subtitle + **Усі проєкти / Цей проєкт** toggle +
  «Нова задача».
- **Static columns**: no drag-drop. Card actions (edit / delete / stop / start)
  stay on the card, as today (`BoardPage.vue:109-112`, force-stop escape hatch
  preserved).

### Чат (standalone)

Promote the existing quick chat (`api.createChat`, read-only tool subset
`CHAT_TOOLS = ['read','grep','glob']`, `supervisor.service.ts:53-55`) into a
top-nav screen: user bubbles + assistant responses (`KChatMessage`,
`KThoughtToggle`) + `KComposer`. "Лише читання" is a read-only **indicator** of
the chat's nature, not a new mode.

## Build/skip decisions (decided)

| v3 element | decision |
|---|---|
| Витрати / Токени (sidebar) | **skip** — no backend |
| PRO badge (user chip) | **skip** — no tiers |
| Theme toggle | **build** — top-bar `☀`/`☾`; supersedes the original dark-only decision |
| Історія (sidebar) | **build** — completed sessions list (`merged/done/stopped`) |
| Зміни tab | **build** — `finishInfo` summary + changed-files list |
| Сесія tab | **build** — metadata + actions from existing routes |
| Дошка interactivity | **static columns** + card actions (no drag-drop) |
| Composer: reasoning / Авто-правки | wire only if omp supports; else omit |
| Composer: model / worktree / tokens | **build** — backed by existing state |
| Лише читання (Chat) | indicator only — chats are already read-only |

## Sequencing & review checkpoints

1. **Design system** — rewrite tokens + global scss + fonts. Review: Foundations
   panel in `KitGalleryPage`.
2. **UI-kit** — restyle the 24 `K*`, add the new primitives, retire `KTable`
   from the board, extract `KComposer`. Review: full `KitGalleryPage` sign-off.
3. **Screens** (each reviewed live in the running app):
   3a. Shell/IA — `MainLayout` top bar (`KTopNav`) + sidebar.
   3b. Агенти — three-pane list + detail + tabs.
   3c. Дошка — Kanban restyle.
   3d. Чат — standalone screen.

## Out of scope / non-goals

- Sidebar costs/tokens, PRO badge.
- Full file-diff viewer (Зміни shows a summary + changed files only).
- Board drag-drop status transitions.
- New omp capabilities: reasoning/auto-edit controls are wired only if omp
  already exposes them.

## Risks & to-verify

- **omp composer capabilities** — whether reasoning effort / auto-edit are
  settable via RPC. Verify during Phase 3; omit if absent.
- **`KTable` usages** — confirm no non-board tabular consumer before retiring it.
- **`finishInfo` extension** — adding changed files must not slow the existing
  finish flow (bound the `git diff --numstat`).
- **Selector specificity** — restyling many components at once risks
  cancelling CSS rules; keep component styles scoped, avoid element+type
  selector collisions (noted in frontend-design guidance).

## Verification

- Phases 1–2: `KitGalleryPage` renders every token and component in v3 style;
  visual sign-off in the browser; `pnpm --filter @kermanych/ui typecheck`.
- Phase 3: each screen driven live in the running app (browser) against real
  sessions/board/chat; existing UI tests kept green
  (`pnpm --filter @kermanych/ui test`); add tests only for new observable
  contracts (e.g. the `VIEW_HISTORY` bucket filter, the changed-files summary).
- No regression to the API/core suites (`pnpm -r test`).
