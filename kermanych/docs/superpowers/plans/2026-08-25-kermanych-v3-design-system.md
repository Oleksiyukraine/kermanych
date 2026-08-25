# Kermanych v3 — Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolor and expand `@kermanych/tokens` to the v3 design language (cool near-black surfaces, system UI font, full status/radii/spacing scales) and prove it in a Foundations gallery panel — without touching component internals yet.

**Architecture:** Tokens are CSS custom properties in `packages/tokens/src/tokens.css`, mirrored as a typed `tokens` object in `index.ts`, and loaded app-wide via `apps/ui/src/boot/tokens.ts`. Existing token NAMES are kept (recolored in place) so every current `var(--k-*)` reference keeps resolving; new tokens are added for Phase 2. The global "radius 0" rule is removed so v3's rounded surfaces are possible.

**Tech Stack:** Vue 3 / Quasar (Vite), SCSS, TypeScript, pnpm workspaces, `@fontsource/*`.

**Spec:** `docs/superpowers/specs/2026-08-25-kermanych-v3-redesign-design.md`

**Note on verification:** This is presentational (tokens + global CSS), so tasks verify by typecheck + a live visual check in `KitGalleryPage`, not unit tests. The design spec's Verification section mandates exactly this for Phases 1–2.

## Global Constraints

- Node ≥22.12 (repo README). Use `pnpm` only; never `npm`/`yarn`.
- Keep existing token names (`--k-canvas`, `--k-bg`, `--k-surface`, `--k-surface2`, `--k-line`, `--k-line-strong`, `--k-text`, `--k-muted`, `--k-accent`, `--k-diff`, `--k-font-ui`, `--k-font-mono`) — recolor, do not rename. Add new tokens alongside.
- Brand accent is unchanged: `#ff563c`.
- Dark-only. No light theme, no theme toggle.
- File contents in English (repo convention); Ukrainian only in user-facing UI copy.
- Surface lightness order must stay canvas < bg < surface < surface2 (darkest→lightest).

---

## Task 1: Rewrite design tokens

**Files:**
- Modify: `packages/tokens/src/tokens.css` (full rewrite)
- Modify: `packages/tokens/src/index.ts` (full rewrite)
- Modify: `packages/tokens/src/fonts.css` (drop Archivo)
- Modify: `packages/tokens/package.json:5` (drop `@fontsource/archivo`)
- Modify: `apps/ui/src/boot/tokens.ts:3` (comment only)

**Interfaces:**
- Produces (consumed by all later Phase 1–3 tasks): CSS variables and the typed `tokens` object below. Phase 2 restyles every `K*` component against these names.

- [ ] **Step 1: Rewrite `packages/tokens/src/tokens.css`**

```css
:root {
  /* surfaces — cool near-black, darkest→lightest */
  --k-canvas:#050505; --k-bg:#141414; --k-surface:#1c1c1c; --k-surface2:#2b2b2b;
  /* borders */
  --k-line:rgba(255,255,255,.08); --k-line-strong:rgba(255,255,255,.14);
  /* text */
  --k-text:#ededed; --k-muted:#8a8a8a; --k-faint:#6b6b6b; --k-on-accent:#0a0a0a;
  /* brand */
  --k-accent:#ff563c; --k-accent-hover:#ff6a52;
  /* status */
  --k-success:#28c840; --k-warning:#febc2e; --k-danger:#ff5f57;
  /* diff (keep --k-diff for existing refs; add directional) */
  --k-diff:#28c840; --k-diff-add:#28c840; --k-diff-del:#ff5f57;
  /* type */
  --k-font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --k-font-mono:'JetBrains Mono',ui-monospace,monospace;
  --k-fs-xs:11px; --k-fs-sm:12px; --k-fs-base:13px; --k-fs-md:15px; --k-fs-lg:18px;
  --k-fw-regular:400; --k-fw-medium:500; --k-fw-semibold:600;
  /* radii */
  --k-r-sm:6px; --k-r:8px; --k-r-lg:12px; --k-r-pill:999px;
  /* spacing (8pt) */
  --k-sp-1:4px; --k-sp-2:8px; --k-sp-3:12px; --k-sp-4:16px; --k-sp-5:20px; --k-sp-6:24px; --k-sp-7:32px;
  /* rules */
  --k-rule-thin:1px; --k-rule-strong:2px;
}
```

- [ ] **Step 2: Rewrite `packages/tokens/src/index.ts`**

```ts
export const tokens = {
  color: {
    canvas: "#050505", bg: "#141414", surface: "#1c1c1c", surface2: "#2b2b2b",
    line: "rgba(255,255,255,.08)", lineStrong: "rgba(255,255,255,.14)",
    text: "#ededed", muted: "#8a8a8a", faint: "#6b6b6b", onAccent: "#0a0a0a",
    accent: "#ff563c", accentHover: "#ff6a52",
    success: "#28c840", warning: "#febc2e", danger: "#ff5f57",
    diff: "#28c840", diffAdd: "#28c840", diffDel: "#ff5f57",
  },
  font: { ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", mono: "'JetBrains Mono', monospace" },
  fontSize: { xs: "11px", sm: "12px", base: "13px", md: "15px", lg: "18px" },
  fontWeight: { regular: 400, medium: 500, semibold: 600 },
  radius: { sm: "6px", base: "8px", lg: "12px", pill: "999px" },
  space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 7: "32px" },
  rule: { thin: "1px", strong: "2px" },
} as const;
export type Tokens = typeof tokens;
```

- [ ] **Step 3: Rewrite `packages/tokens/src/fonts.css`** (drop Archivo, keep JetBrains Mono 400 + add 500)

```css
@import "@fontsource/jetbrains-mono/400.css";
@import "@fontsource/jetbrains-mono/500.css";
```

- [ ] **Step 4: Drop the Archivo dependency in `packages/tokens/package.json`**

Change line 5 from:

```json
  "dependencies": { "@fontsource/archivo": "^5", "@fontsource/jetbrains-mono": "^5" }
```

to:

```json
  "dependencies": { "@fontsource/jetbrains-mono": "^5" }
```

- [ ] **Step 5: Update the boot comment in `apps/ui/src/boot/tokens.ts:3`**

Change:

```ts
// Kermanych design tokens: fonts (Archivo + JetBrains Mono) and CSS variables.
```

to:

```ts
// Kermanych design tokens: fonts (JetBrains Mono) and CSS variables.
```

- [ ] **Step 6: Refresh the lockfile**

Run: `pnpm install`
Expected: succeeds; `@fontsource/archivo` removed from the lockfile, no other diffs.

- [ ] **Step 7: Typecheck the UI (tokens are consumed here)**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS (no type errors; `tokens` shape still satisfies any importer).

- [ ] **Step 8: Commit**

```bash
git add packages/tokens apps/ui/src/boot/tokens.ts pnpm-lock.yaml
git commit -m "feat(tokens): recolor to v3 cool palette + expand scale"
```

---

## Task 2: Global stylesheet + Quasar variables

**Files:**
- Modify: `apps/ui/src/css/app.scss:12-16` (remove the global `border-radius:0` rule)
- Modify: `apps/ui/src/css/quasar.variables.scss:5-15` (recolor to v3)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: rounded surfaces are now possible app-wide; Quasar's own theme variables match v3.

- [ ] **Step 1: Remove the "radius 0 everywhere" rule from `apps/ui/src/css/app.scss`**

Delete lines 12–16:

```scss
// Modernist rule: radius 0 everywhere (macOS window buttons are the only
// documented exception, handled where those controls live).
* {
  border-radius: 0;
}
```

Leave the rest of the file unchanged.

- [ ] **Step 2: Recolor `apps/ui/src/css/quasar.variables.scss`**

Replace lines 5–15:

```scss
$primary   : #ff563c; // accent
$secondary : #8a8a8a; // muted
$accent    : #ff563c;

$dark      : #141414; // surface
$dark-page : #050505; // canvas

$positive  : #28c840; // success / diff-add
$negative  : #ff5f57; // danger
$info      : #8a8a8a; // muted
$warning   : #febc2e; // warning
```

- [ ] **Step 3: Typecheck + build the UI**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/css/app.scss apps/ui/src/css/quasar.variables.scss
git commit -m "feat(ui): drop global radius-0, recolor Quasar vars to v3"
```

---

## Task 3: Foundations panel in the kit gallery

**Files:**
- Modify: `apps/ui/src/pages/KitGalleryPage.vue` (add a Foundations `<section>` after the masthead at line 9; update the lede at line 7; add scoped styles)

**Interfaces:**
- Consumes: all tokens from Task 1.
- Produces: a visual sign-off surface for the design system (swatches, type scale, radii).

- [ ] **Step 1: Update the lede** at `apps/ui/src/pages/KitGalleryPage.vue:7`

Change:

```html
        Modernist dark kit. Radius 0, single accent, flush-left labels, mono for machine text.
```

to:

```html
        Dark kit. Cool near-black surfaces, single vermilion accent, rounded cards, mono for machine text.
```

- [ ] **Step 2: Insert a Foundations section** immediately after the `</header>` (line 9), before the `<!-- 03 — agent statuses -->` section:

```html
    <!-- 00 — foundations (design system) -->
    <section class="kit__section">
      <div class="kit__label">00 · Основи</div>
      <div class="kit__swatches">
        <div v-for="c in swatches" :key="c.var" class="kit__swatch">
          <span class="kit__chip" :style="{ background: `var(${c.var})` }"></span>
          <span class="kit__swatch-name mono">{{ c.var }}</span>
        </div>
      </div>
      <div class="kit__typescale">
        <div v-for="t in typeScale" :key="t.var" class="kit__type" :style="{ fontSize: `var(${t.var})` }">
          {{ t.label }} <span class="mono kit__type-tag">{{ t.var }}</span>
        </div>
      </div>
      <div class="kit__radii">
        <div v-for="r in radii" :key="r.var" class="kit__radius" :style="{ borderRadius: `var(${r.var})` }">
          <span class="mono">{{ r.var }}</span>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: Add the data + scoped styles** in `KitGalleryPage.vue`

In `<script setup>`, add:

```ts
const swatches = [
  { var: '--k-canvas' }, { var: '--k-bg' }, { var: '--k-surface' }, { var: '--k-surface2' },
  { var: '--k-text' }, { var: '--k-muted' }, { var: '--k-faint' },
  { var: '--k-accent' }, { var: '--k-success' }, { var: '--k-warning' }, { var: '--k-danger' },
];
const typeScale = [
  { var: '--k-fs-lg', label: 'Заголовок екрана 18' },
  { var: '--k-fs-md', label: 'Заголовок 15' },
  { var: '--k-fs-base', label: 'Основний текст 13' },
  { var: '--k-fs-sm', label: 'Другорядний 12' },
  { var: '--k-fs-xs', label: 'Мета 11' },
];
const radii = [
  { var: '--k-r-sm' }, { var: '--k-r' }, { var: '--k-r-lg' }, { var: '--k-r-pill' },
];
```

In `<style scoped>`, add:

```scss
.kit__swatches { display: flex; flex-wrap: wrap; gap: var(--k-sp-3); }
.kit__swatch { display: flex; flex-direction: column; gap: var(--k-sp-1); align-items: center; }
.kit__chip { width: 56px; height: 40px; border-radius: var(--k-r); border: 1px solid var(--k-line-strong); }
.kit__swatch-name { font-size: var(--k-fs-xs); color: var(--k-muted); }
.kit__typescale { display: flex; flex-direction: column; gap: var(--k-sp-2); margin-top: var(--k-sp-4); color: var(--k-text); }
.kit__type-tag { font-size: var(--k-fs-xs); color: var(--k-faint); }
.kit__radii { display: flex; gap: var(--k-sp-3); margin-top: var(--k-sp-4); }
.kit__radius { width: 72px; height: 48px; background: var(--k-surface); border: 1px solid var(--k-line-strong); display: flex; align-items: center; justify-content: center; font-size: var(--k-fs-xs); color: var(--k-muted); }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 5: Visual verification (live)**

Run the UI dev server (`pnpm --filter @kermanych/ui dev`), open the kit gallery route, and confirm in the browser:
- Background is near-black `#050505`; cards read as `#141414`/`#1c1c1c`.
- The 11 swatches render the recolored palette; accent is `#ff563c`.
- The type scale steps 11→18px; UI text is the system font, `.mono` is JetBrains Mono.
- The radii row shows 6/8/12/pill rounding (proving the global radius-0 rule is gone).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/pages/KitGalleryPage.vue
git commit -m "feat(ui): Foundations panel in kit gallery (v3 tokens)"
```

---

## Self-review

- **Spec coverage:** implements the spec's "Design system" section (palette, type,
  radii, spacing, elevation, drop Archivo) and its Phase-1 review harness
  (Foundations panel in `KitGalleryPage`). UI-kit and screens are out of this
  plan by design (later JIT plans).
- **No placeholders:** every step has exact file paths, line numbers, and full
  code.
- **Type consistency:** `tokens` keys (Task 1) are the only new TS surface; no
  later task in this plan references undefined symbols. CSS var names are used
  verbatim in Tasks 2–3 exactly as defined in Task 1.

## Next plans (JIT, after this lands)

- `2026-08-25-kermanych-v3-ui-kit.md` — restyle the 24 `K*` + new primitives,
  reviewed in `KitGalleryPage`.
- `2026-08-25-kermanych-v3-screens.md` — shell/IA, Агенти, Дошка, Чат.
