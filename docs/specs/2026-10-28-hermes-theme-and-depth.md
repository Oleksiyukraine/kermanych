# Hermes theme, subtle depth for every theme, running-session ring

## Goal

1. Add a fourth colour theme, `hermes`, modelled on Hermes Agent by Nous Research
   (hermes-agent.nousresearch.com and its desktop app): a graphite-blue dark substrate with
   one cyan accent.
2. Give every theme light gradients and shadows on raised and clickable surfaces, without
   making the UI loud.
3. Give the selected session card a gradient frame whose light runs around it while that
   agent works — the effect the operator liked on Hermes' active chat.

## Context

- Themes: `packages/tokens/src/tokens.css` (`:root` = dark, `[data-theme='light']`,
  `[data-theme='matrix']`, colour tokens only) and its typed mirror
  `packages/tokens/src/index.ts` (`KTheme`, `color`, `shadow`).
- Runtime: `apps/ui/src/lib/theme.ts` (`THEMES` allow-list and toggle order, `setTheme`:
  digital rain into `matrix`, circle wipe otherwise). Pickers: shell toggle in
  `layouts/MainLayout.vue` (`NEXT_THEME`, `THEME_GLYPH`, `THEME_TITLE_KEY`) and the segmented
  control in `pages/SettingsPage.vue`. Pre-paint copy of the theme list and splash colours in
  `apps/ui/index.html`. Electron reads `--k-canvas` off the computed style, so it needs no change.
- Depth today: three shadow tokens (`--k-shadow-pop|toast|modal`) used by menus, toasts and
  modals; no gradients in components. Everything else is flat.
- Hermes brand palette (site CSS): blue `#0000f2`, cyan `#00f2f2`, neutral `#616191`, dark
  marketing background `#19192f`. The desktop app (operator's screenshots): graphite-blue
  near-black surfaces, cyan accent («Cyber cyan») on the selected row, section titles and links.
- Selected session card: `components/kit/KSessionCard.vue` (`selected`, `status` props),
  used by `AgentsPage.vue` (session list) and `ChatPage.vue` (thread list). Selection is only
  a `--k-surface2` fill today.

## Decisions

1. **Palette direction: the Hermes desktop app** — graphite-blue surfaces, cyan accent,
   neutrals with the brand's blue-violet cast. The raw brand cyan `#00f2f2` is not used as is:
   the accent is also small text, so it is toned down. Theme id `hermes` (the task's
   «Hermess» was a typo). Rejected: the Hermès fashion house palette (not what was meant);
   a different accent hue.
2. **Hermes values** (overrides colour tokens only, `color-scheme: dark`):

   | token | value | contrast on `--k-surface` |
   |---|---|---|
   | canvas / bg / surface / surface2 | `#0a0c11` / `#10131a` / `#161a23` / `#202633` | — |
   | line / line-strong | `rgba(150,165,210,.09)` / `rgba(150,165,210,.15)` | — |
   | text | `#e6e9f0` | 14.3:1 |
   | muted | `#8d93a8` | 5.7:1 |
   | faint (decorative, as in dark) | `#646a80` | 3.3:1 |
   | accent / accent-hover | `#4fd1e0` / `#6edbe8` | 9.6:1 / 10.8:1 |
   | on-accent | `#04161a` | 10.2:1 on accent |
   | success / warning / danger | `#3ecf8e` / `#e8c35a` / `#f0716b` | 8.7 / 10.3 / 6.0:1 |
   | diff / diff-add / diff-del | success / success / danger | — |

   Shadows use a blue-black (`rgba(2,4,12,…)`) instead of neutral black. Final values may be
   tuned during the visual check; every foreground token keeps ≥ 4.5:1 on `--k-surface`.
3. **Depth applies to all four themes** through new tokens, each theme with its own values.
   This deliberately changes how `dark`, `light` and `matrix` look today; the bar is «visible
   when you look for it». Components read tokens only — no per-theme component selectors.
   Rejected: Hermes only (operator wants depth everywhere); a separate
   `[data-theme='hermes']` stylesheet overriding component classes (a second styling scheme
   that breaks when classes change).
4. **New depth tokens** (names fixed here, values per theme in `tokens.css` and mirrored in
   `index.ts`):
   - `--k-sheen` — 1px inner top highlight (`inset 0 1px 0 …`) for raised layers and cards;
   - `--k-grad-raise` — faint vertical background overlay for raised surfaces
     (`linear-gradient(180deg, <2–4% lighter>, transparent)`), layered over the surface colour;
   - `--k-shadow-card` / `--k-shadow-card-hover` — card rest / hover shadow (rest almost
     invisible);
   - `--k-grad-accent` — primary fill's lift: a translucent white overlay
     (`linear-gradient(180deg, rgba(255,255,255,.08), transparent)`, ~4–8% lighter at the top
     in every theme) layered as a background-image over `--k-accent`. It is an overlay, not a
     full fill, because a gradient image cannot be transitioned: the first cut swapped an
     opaque gradient for a plain `--k-accent-hover` fill on hover, so the colour faded in from
     transparent and the button blinked;
   - `--k-glow-focus` — accent glow around a focused composer.
   Existing `--k-shadow-pop|toast|modal` stay and keep their meaning.
5. **Where depth goes — targeted:**
   1. floating layers (`KModal`, `KToast`, menus in `KChipSelect`, `KSplitButton`,
      `AgentsPage` menu, `KFileManager` popover): existing shadow + `--k-sheen` +
      `--k-grad-raise`;
   2. cards (`KSessionCard`, `KKanbanCard`, `home/HomeTile`): `--k-shadow-card`, deepening to
      `--k-shadow-card-hover` on hover, plus `--k-sheen`;
   3. primary button (`KBtn` primary): `--k-accent` colour + `--k-grad-accent` image; hover
      (and the open ▾ of `KSplitButton`) changes only the colour to `--k-accent-hover`;
   4. composer (`KComposer`): light shadow at rest, `--k-glow-focus` while focused.
   Large planes (sidebar, canvas, chat log) stay solid. Rejected: gradients on large planes
   (banding on dark gradients, corner glows read as loud); a minimal set (floating layers and
   primary button only).
6. **Running ring on the selected session card.** The selected `KSessionCard` always wears a
   thin static gradient frame in the theme accent. While its `status` is `queued`, `thinking`
   or `tool` (the `running` level of `lib/attention.ts`; not `waiting_input`), the light runs
   around the frame (a conic gradient whose angle is animated via a registered `@property`,
   masked to the border). Finished or waiting → the frame stands still. Under
   `prefers-reduced-motion: reduce` the frame is always static. Applies to both lists that use
   the card (Агенти, Чати), in every theme. Rejected: always animated (endless motion on a
   finished session distracts); animating every running card (five parallel agents turn the
   list into a garland).
7. **Entering Hermes uses the circle wipe** (`lib/reveal.ts`), like dark/light. Rejected: a
   custom canvas reveal like the Matrix rain — more code to own, and it would make this theme
   louder than the others.
8. **Shell toggle: Hermes last in the cycle** — `dark → light → matrix → hermes → dark`.
   Glyph ☿ (Mercury, Hermes' Roman name; continues the ☾/☀ celestial pair). Title «Тема
   Hermes» / «Hermes theme»; settings label «Hermes» in both locales (a brand name). The
   existing order is unchanged; only `matrix` now leads to `hermes` instead of `dark`.
   Rejected: settings-only; Hermes right after dark.

## Changes

- `packages/tokens/src/tokens.css` — `:root[data-theme='hermes']` block with rationale
  comment; new depth tokens in `:root`, light, matrix and hermes; header comment says four
  themes.
- `packages/tokens/src/index.ts` — `KTheme` gains `hermes`; `color.hermes`, `shadow.hermes`;
  depth tokens mirrored for every theme.
- `apps/ui/src/lib/theme.ts` — `THEMES` gains `hermes`; comments on the cycle.
- `apps/ui/index.html` — pre-paint allow-list accepts `hermes`; `html` background and splash
  variables for `hermes`.
- `apps/ui/src/layouts/MainLayout.vue` — `NEXT_THEME`, `THEME_GLYPH`, `THEME_TITLE_KEY`.
- `apps/ui/src/pages/SettingsPage.vue` — fourth segment.
- i18n uk/en — `common.nav.themeHermes`, `settings.app.themeHermes`.
- Components per decision 5; `KSessionCard.vue` ring per decision 6. The `KFileManager`
  viewer takes the sheen only — it is up to 1400px wide, too large a plane for the overlay.
- `apps/ui/src/lib/attention.ts` — `isRunningStatus(status)` extracted from the sidebar
  tally, so the ring and the sidebar's «працює» share one definition of «running».
- `apps/ui/test/theme.spec.ts` — reads `hermes`; cycle `dark → light → matrix → hermes → dark`.

## Verification

- `apps/ui`: `vitest run --maxWorkers=4 --minWorkers=1` — 66 files, 727 tests pass;
  `vue-tsc --noEmit` clean.
- `packages/tokens/src/index.ts`: `tsc --noEmit --strict` clean (`satisfies Record<KTheme, …>`
  holds for `color`, `shadow`, `depth`).
- Seeded preview (api `KERMANYCH_SEED=1 KERMANYCH_PREVIEW=1`, ui `VITE_KERMANYCH_PREVIEW=1`):
  - reload with `kermanych.theme=hermes` paints Hermes (`--k-canvas` `#0a0c11`);
  - Агенти: selected `thinking` card has `k-session-card--running`, its `--k-ring-angle`
    advanced between reads (299° → 334°); a selected `waiting_input` card has a static
    linear frame and no animation; the running rule sits inside
    `@media (prefers-reduced-motion: no-preference)`, so reduced motion gets the static frame;
  - the split-button menu, primary button, focused composer (glow), new-task modal and kit
    gallery kanban cards render with the depth tokens; dark, light and matrix rechecked on the
    same screen;
  - Settings → Застосунок shows four segments; the shell toggle stepped light → matrix →
    hermes → dark with glyphs ﾏ, ☿, ☾.
  Not exercised: the Electron window background (reads the computed `--k-canvas`, unchanged
  code); Чати (same `KSessionCard`).

## Documentation impact

None beyond this spec: the README does not describe the theme list, and no command, config
key or API changes.
