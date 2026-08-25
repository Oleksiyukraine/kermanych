# Kermanych v3 — UI-kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the 24 existing `K*` components to the v3 language and add the new primitives v3 needs, all reviewed in `KitGalleryPage`, without touching screens yet.

**Architecture:** Presentational Vue 3 SFCs under `apps/ui/src/components/kit`. Phase 1 already recolored the tokens and removed the global `radius:0` rule; this phase applies real radii, fixes the few hardcoded colors, and builds new components against the token contract. The kit gallery (`apps/ui/src/pages/KitGalleryPage.vue`, route `/kit`) is the review surface.

**Tech Stack:** Vue 3 / Quasar (Vite), SCSS scoped styles, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-25-kermanych-v3-redesign-design.md`
**Predecessor plan:** `docs/superpowers/plans/2026-08-25-kermanych-v3-design-system.md` (Phase 1, done)

## Global Constraints

- Token contract (Phase 1) — use these, never hardcode:
  - surfaces `--k-canvas/-bg/-surface/-surface2`; borders `--k-line/-line-strong`;
    text `--k-text/-muted/-faint/-on-accent`; brand `--k-accent/-accent-hover`;
    status `--k-success/-warning/-danger`; diff `--k-diff-add/-diff-del`.
  - radii `--k-r-sm(6)/-r(8)/-r-lg(12)/-r-pill(999)`; spacing `--k-sp-1..7`;
    type `--k-fs-xs..lg`, `--k-fw-regular/-medium/-semibold`; fonts `--k-font-ui/-mono`.
- Every new component is added to `KitGalleryPage` with all its states.
- Verify per task: `pnpm --filter @kermanych/ui typecheck` + live visual in `/kit`
  (dev server in preview mode: `PORT=<p> VITE_KERMANYCH_PREVIEW=1 pnpm --filter @kermanych/ui dev`).
- Match the v3 reference (`design/kermanych-v3.html`) — dark, rounded, vermilion accent.
- Parallel-execution serialization points: `KitGalleryPage.vue` (one integration owner) and `KPanel.vue` (Task R5 only). All other component files are independent.

## Restyle rule (applies to every R-task)

For each listed component's scoped `<style>`:

1. Replace `border-radius: 0;` with the element's v3 radius:
   - buttons, icon-buttons, inputs, selects, fields, checkbox box, toggle segments, rail items, attach chips, user button → `var(--k-r)`
   - tags/small chips → `var(--k-r-sm)`; status/running chips → `var(--k-r-pill)`
   - modal, toast, panel, cards → `var(--k-r-lg)`
   - status dot → `50%` (a circle)
2. Replace hardcoded colors with tokens: `#ff6a52` → `var(--k-accent-hover)`; `#111` → `var(--k-on-accent)`.
3. Leave existing `var(--k-*)` refs — Phase 1 recolored them.
4. Where padding/margins are ad-hoc, snap to `--k-sp-*` matching the reference.
5. Confirm hover / active / disabled / focus-visible states still read correctly.

---

## Task R1: Restyle controls

**Files (Modify):** `KBtn.vue` `KIconButton.vue` `KToggle.vue` `KCheckbox.vue` `KSelect.vue` `KField.vue` `KColorPicker.vue` `KDirPicker.vue` (all under `apps/ui/src/components/kit/`)

- [ ] **Step 1:** Apply the Restyle rule to each. Specifics: `KBtn.vue:47` radius→`var(--k-r)`, `:63` `#ff6a52`→`var(--k-accent-hover)`; icon-button/checkbox/select/field/toggle radii→`var(--k-r)`; `KColorPicker` swatches radius→`var(--k-r-sm)` and update the palette green `#3fb950`→`#28c840` to match `--k-success`.
- [ ] **Step 2:** `pnpm --filter @kermanych/ui typecheck` → PASS.
- [ ] **Step 3:** Visual check in `/kit` sections 04 (buttons, icon buttons) + form controls: rounded, hover/disabled correct.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): restyle controls to v3 (radii, accent-hover)"`

## Task R2: Restyle status + tags

**Files (Modify):** `KStatusDot.vue` `KTag.vue` `KStatusRow.vue` `KStatusBar.vue` `KTable.vue`

- [ ] **Step 1:** `KStatusDot.vue:46` radius→`50%` (circle); map its kinds to `--k-success/-warning/-danger/-accent`. `KTag.vue:25` radius→`var(--k-r-sm)`. `KTable.vue` row radius/hover to v3 (`--k-r` on cells is not needed; keep flush, but active row inset uses `--k-accent`). `KStatusRow`/`KStatusBar` chips → `--k-r-pill` for status pills.
- [ ] **Step 2:** typecheck → PASS.
- [ ] **Step 3:** Visual check `/kit` section 03 (statuses) — dots are circles in the right colors.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): restyle status + tags to v3 (round dot, pill chips)"`

## Task R3: Restyle transcript

**Files (Modify):** `KToolRow.vue` `KToolCard.vue` `KLogBlock.vue` `KTodoLane.vue` `KRequestBlock.vue`

- [ ] **Step 1:** Apply the Restyle rule. `KToolCard.vue:50-53` already uses `--k-diff`/`--k-accent` for add/del — switch del to `var(--k-diff-del)` and add to `var(--k-diff-add)`. Tool rows/cards get `var(--k-r)` where boxed; request block panel `var(--k-r-lg)`.
- [ ] **Step 2:** typecheck → PASS.
- [ ] **Step 3:** Visual check `/kit` log/panel sections — diffs green add / red del, rounded cards.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): restyle transcript to v3 (radii, diff colors)"`

## Task R4: Restyle overlays + shell bits

**Files (Modify):** `KModal.vue` `KToast.vue` `KUserButton.vue` `KAttachStrip.vue` `KEnvEditor.vue` `KRailItem.vue`

- [ ] **Step 1:** `KModal.vue:40` radius→`var(--k-r-lg)`; `KToast.vue:45` radius→`var(--k-r-lg)`; `KUserButton.vue:63` radius→`var(--k-r)`; `KAttachStrip.vue:63` radius→`var(--k-r-sm)`; `KRailItem.vue:83` radius→`var(--k-r)`; `KEnvEditor` inputs→`var(--k-r)`.
- [ ] **Step 2:** typecheck → PASS.
- [ ] **Step 3:** Visual check `/kit` (modal, toast, rail, user button).
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): restyle overlays + shell bits to v3"`

## Task R5: Restyle KPanel + extract KComposer

**Files:** Modify `KPanel.vue`; Create `apps/ui/src/components/kit/KComposer.vue`

**Interfaces (Produces — consumed by Phase 3 Агенти + Чат):**
- `KComposer` props: `modelValue: string`, `placeholder?: string`, `disabled?: boolean`, `model?: string`, `worktree?: boolean`, `tokenCount?: number`.
- `KComposer` emits: `update:modelValue`, `send: [text: string, images: ImageInput[]]`.

- [ ] **Step 1:** Extract the composer (`KPanel.vue:157-217` + its helpers `fieldEl`, `MAX_COMPOSER_HEIGHT`, `onComposerKeydown`, `autoGrow`, attach handling) into `KComposer.vue`. Preserve behavior: Enter sends, Shift+Enter newline, IME-safe, auto-grow to 160px, paste/drop/📎 attach via `useImageAttach`. Add the v3 controls row: model chip, worktree chip, token count, send FAB (accent circle, `var(--k-r-pill)`).
- [ ] **Step 2:** In `KPanel.vue`, replace the inline composer with `<KComposer v-model="draft" ... @send="..." />`; keep KPanel's `send` emit wiring. Apply the Restyle rule to KPanel's own styles (`:818,:851` radii→`var(--k-r)`; `:738,:983` `#111`→`var(--k-on-accent)`; panel container → `var(--k-r-lg)`).
- [ ] **Step 3:** typecheck → PASS.
- [ ] **Step 4:** Visual check `/kit` panel sections — composer works (type, Enter, attach), panel rounded, active/error states correct.
- [ ] **Step 5:** Commit: `git commit -m "feat(ui): extract KComposer, restyle KPanel to v3"`

---

## Task N1: KTopNav (segmented navigation)

**Files:** Create `apps/ui/src/components/kit/KTopNav.vue`

**Interfaces (Produces):** props `modelValue: string`, `options: { value: string; label: string }[]`; emits `update:modelValue`.

- [ ] **Step 1:** Build a pill-segmented control: a `--k-surface2` track (`--k-r-pill`), each option a button; active = `--k-accent` bg + `--k-on-accent` text; inactive = `--k-muted`, hover → `--k-text`. `--k-fs-base`, `--k-fw-medium`.
- [ ] **Step 2:** Add a `/kit` section demoing it (`Агенти/Дошка/Чат`, bound to a local ref).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KTopNav segmented control"`

## Task N2: KNavItem + KCount

**Files:** Create `KNavItem.vue`, `KCount.vue`

**Interfaces (Produces):**
- `KCount` props `value: number` — a muted pill (`--k-surface2`, `--k-fs-xs`, `--k-r-pill`).
- `KNavItem` props `label: string`, `count?: number`, `active?: boolean`, `icon?: string`; emits `click`. Active = `--k-surface2` bg + `--k-text`; else `--k-muted`. Renders optional icon, label (flex-1), `KCount` when `count != null`.

- [ ] **Step 1:** Build both. `KNavItem` uses `KCount` for the trailing count.
- [ ] **Step 2:** Add a `/kit` section (Активні 3 / Задачі 5 / Відкладені 12 / Історія).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KNavItem + KCount"`

## Task N3: KSessionCard

**Files:** Create `KSessionCard.vue`

**Interfaces (Produces):** props `branch: string`, `title: string`, `time: string`, `status: SessionStatus`, `statusLine?: string`, `selected?: boolean`; emits `click`.

- [ ] **Step 1:** Build the card: branch (`--k-font-mono`, `--k-faint`, `--k-fs-xs`) + time (right, `--k-faint`) on the top row; title (`--k-text`, `--k-fs-base`); a status row = `KStatusDot :status` + `statusLine` (`--k-muted`, `--k-fs-sm`). Card `--k-surface2`, `--k-r-lg`, `--k-sp-3` padding; `selected` = inset `--k-accent` ring. Import `SessionStatus` from `@kermanych/core`.
- [ ] **Step 2:** Add a `/kit` section with a few sample cards (running/waiting/merged/done).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KSessionCard"`

## Task N4: KKanbanColumn + KKanbanCard

**Files:** Create `KKanbanColumn.vue`, `KKanbanCard.vue`

**Interfaces (Produces):**
- `KKanbanColumn` props `label: string`, `count: number`; default slot = cards. Header = label + `KCount`; body = vertical stack, gap `--k-sp-2`.
- `KKanbanCard` props `title: string`, `branch: string`, `project: string`, `time: string`, `status: SessionStatus`; emits `click`. Card `--k-surface2`, `--k-r-lg`: status dot + title, branch (mono), `project · time` (`--k-faint`).

- [ ] **Step 1:** Build both.
- [ ] **Step 2:** Add a `/kit` section with a 2-column sample (Беклог / В роботі).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KKanbanColumn + KKanbanCard"`

## Task N5: KChatMessage + KThoughtToggle

**Files:** Create `KChatMessage.vue`, `KThoughtToggle.vue`

**Interfaces (Produces):**
- `KChatMessage` props `role: 'user' | 'assistant'`; default slot = content. `user` = right-aligned bubble (`--k-surface2`, `--k-r-lg`, max-width ~70%); `assistant` = full-width plain prose (reuse `.k-log__markdown`).
- `KThoughtToggle` props `label: string`, `open?: boolean`; emits `toggle`; default slot = hidden body. Collapsed row `▸ {label}` (`--k-faint`, `--k-fs-sm`).

- [ ] **Step 1:** Build both.
- [ ] **Step 2:** Add a `/kit` section (a user bubble + a `Думав 8с` toggle with body).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KChatMessage + KThoughtToggle"`

## Task N6: KTabs

**Files:** Create `KTabs.vue`

**Interfaces (Produces):** props `modelValue: string`, `tabs: { value: string; label: string }[]`; emits `update:modelValue`.

- [ ] **Step 1:** Build underline tabs: active = `--k-text` + 2px `--k-accent` bottom border; inactive = `--k-muted`, hover → `--k-text`. `--k-fs-base`, `--k-fw-medium`.
- [ ] **Step 2:** Add a `/kit` section (Лог / Зміни / Сесія).
- [ ] **Step 3:** typecheck → PASS; visual check.
- [ ] **Step 4:** Commit: `git commit -m "feat(ui): add KTabs"`

---

## Final gallery review

- [ ] Run the dev server in preview mode; walk every `/kit` section against `design/kermanych-v3.html`. Confirm: rounded surfaces, vermilion accent only where v3 uses it, circular status dots, mono for machine text, consistent spacing.
- [ ] `pnpm --filter @kermanych/ui typecheck` and `pnpm --filter @kermanych/ui test` → PASS.

## Self-review

- **Spec coverage:** implements the spec's "UI-kit" section — restyle of all 24 `K*` (R1–R5) and the new primitives KTopNav, KNavItem/KCount, KSessionCard, KKanban*, KComposer (R5), KChatMessage/KThoughtToggle, KTabs (N1–N6). `KThemeToggle` intentionally omitted (spec Out of scope). `KStatusBar` retire is deferred to Phase 3 (screens) since it is still consumed by `MainLayout` today.
- **No placeholders:** each new component task carries its concrete API; restyle tasks carry the exact rule + per-file line refs from the audit.
- **Type consistency:** `KComposer` `send` signature matches KPanel's existing `send: [text, images]`; `SessionStatus` is imported from `@kermanych/core` wherever a status prop appears (KSessionCard, KKanbanCard).

## Next plan (JIT, after this lands)

- `2026-08-25-kermanych-v3-screens.md` — shell/IA (KTopNav + sidebar), Агенти, Дошка, Чат.
