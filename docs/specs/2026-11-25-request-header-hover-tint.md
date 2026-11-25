# Hover tint on the chat's request headers

## Goal

The operator asked for a hover effect on the chat log's section grouping — the request blocks,
one per operator message, each headed by a row with the coral accent bar («Ок · 50 хв · 150
викликів …»). For the dark theme: a soft raspberry or a deeper purple, translucent so it does
not contrast too much.

## Context

The header is `.k-rb__head` in `apps/ui/src/components/kit/KRequestBlock.vue`, a full-width
`<button>` that expands and collapses the block. It had no hover state — only `cursor: pointer`
and a focus outline. KPanel's my-message navigation flashes the same element with
`.k-log--flash` (`apps/ui/src/css/app.scss`), an animation of its `background`.

## Decisions

1. **A new theme token `--k-tint-hover`**, one value per theme, instead of a raspberry literal in
   the component: the light, Matrix and Hermes themes need their own hue and alpha, and
   `--k-surface2` (the neutral hover tint) cannot carry a hue.
   - dark `rgba(214,64,138,.16)` — raspberry: the coral accent's warm neighbour, so it reads as
     related to the bar instead of competing with it. A cold purple was the alternative; next to
     `#ff563c` it reads as a second accent.
   - light `rgba(196,38,110,.08)` — the same hue, half the alpha on white.
   - matrix `rgba(99,160,121,.14)` — the theme's own green; pink breaks the film palette.
   - hermes `rgba(140,120,235,.16)` — the brand's blue-violet cast.
2. **A gradient from the bar, faded out by 75% of the row**, not a solid fill: the log spans the
   panel's full width, and a solid stripe that wide is loud at any alpha that is visible at all.
3. **Painted on `::before`, faded with `opacity`.** A gradient does not transition; and the
   button's own `background` belongs to the `.k-log--flash` animation. `isolation: isolate` on
   the header keeps the `z-index: -1` pseudo-element above the row and under its text.
4. Header only. The tool-group rows inside a block keep their neutral `--k-surface` hover.

## Changes

- `packages/tokens/src/tokens.css` — `--k-tint-hover` in all four theme blocks.
- `packages/tokens/src/index.ts` — `depth.<theme>.tintHover` mirror.
- `apps/ui/src/components/kit/KRequestBlock.vue` — `.k-rb__head::before` wash, shown on
  `:hover`.

## Verification

Live preview (`.kermanych/preview.json`), Agents page. The seeded sessions carry no transcript,
so three `.k-rb` headers with the component's scoped attribute were inserted into the log for
the check and removed after. Real pointer hover over a header: `::before` computes to
`linear-gradient(90deg, rgba(214,64,138,.16), rgba(0,0,0,0) 75%)`, `z-index: -1`; screenshots
show the raspberry wash fading from the bar in dark, a pale pink in light and violet in Hermes,
with the header text unchanged.

Not verified: the Matrix theme and a real session's log (only the inserted headers); the
interaction of the hover wash with a running `.k-log--flash`.

## Documentation impact

None — a visual hover state; no command, setting or flow changes.
