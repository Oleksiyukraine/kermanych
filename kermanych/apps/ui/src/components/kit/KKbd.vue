<template>
  <span class="k-kbd mono" :class="`k-kbd--${tone}`" aria-hidden="true"><slot /></span>
</template>

<script setup lang="ts">
// A keyboard-shortcut chip: ⌘⏎, ⌘S, ⇧⌘K.
//
// These glyphs are the app's third icon family, after KIcon's drawn marks and the Unicode
// action glyphs in KIconButton, and they are the family that fails hardest when sized off the
// TYPE scale. U+2318 and U+23CE carry far less ink than a letter of the same em: JetBrains
// Mono draws ⌘ inside roughly the x-height with side bearings on both flanks, so an 11px ⌘
// lands nearer 8px of visible mark. Beside a 13px/800 button label that is not a quiet hint,
// it is an illegible one — which is exactly what this component replaces.
//
// So the size comes from the ICON scale, not `--k-fs-*`. `sm` is a hair over the 13px label
// it usually follows: the chip has to read as a peer of the label, not as a footnote to it.
//
// Nor is it dimmed with `opacity`. The chip's whole job is to be legible at a glance, and the
// site this replaced stacked 11px on `opacity: .7` — two independent reductions, which is how
// it ended up invisible on the accent fill. Recessiveness here is the mono face and the
// letter-spacing, both of which cost no contrast.
//
// `aria-hidden`: the glyphs are decorative duplicates of an affordance the control already
// names. A screen reader hitting «Запустити ⌘⏎» would read the command symbol as punctuation
// or skip it; the keybinding belongs in the control's own label, not in this span.
withDefaults(
  defineProps<{
    // `on-accent` inherits the parent's colour — for a chip riding inside a filled primary
    // button, where any colour of its own would fight the fill. `muted` is the standalone
    // case: a hint sitting on a panel with no control around it.
    tone?: 'on-accent' | 'muted';
  }>(),
  { tone: 'on-accent' },
);
</script>

<style scoped lang="scss">
.k-kbd {
  flex: none;
  font-size: var(--k-icon-sm);
  line-height: 1;
  // The glyphs are drawn tight in mono; a hair of tracking keeps ⌘ and ⏎ from touching.
  letter-spacing: 0.06em;
  // Trailing tracking would otherwise push the pair off the button's optical centre.
  margin-right: -0.06em;
}

// Inside a filled control: take the control's own foreground, whatever it resolved to.
.k-kbd--on-accent {
  color: inherit;
}

.k-kbd--muted {
  color: var(--k-muted);
}
</style>
