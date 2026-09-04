<template>
  <button
    type="button"
    class="k-icon-btn"
    :class="{ 'k-icon-btn--on': active }"
    v-tip="title"
    :aria-label="title"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
// Dense, glyph-only action control for the app's icon clusters — the agents
// board's per-row actions (run / edit / merge / archive …) and the session
// panel's header controls. Square, muted 1px rule, a single glyph in the default
// slot; `active` lights the accent (e.g. a live preview toggle).
//
// Design-system rule: this is the COMPACT 28px control, sized so several pack
// into one narrow actions column or a 34px panel header. It is deliberately
// distinct from KBtn variant="icon" (the 34px standalone icon control). Reach for
// KIconButton wherever glyph actions sit side by side; reach for
// KBtn variant="icon" for a lone toolbar icon.
//
// `title` drives the app tooltip (`v-tip`, src/lib/tip.ts) instead of the native
// attribute, and doubles as the `aria-label`: the default slot holds a bare
// glyph, which gives the control no accessible name of its own.
//
// `@click`/other listeners fall through to the native <button>, so `@click.stop`
// on the row's action still suppresses the KTable row-click.
withDefaults(
  defineProps<{
    title?: string;
    active?: boolean;
  }>(),
  { active: false },
);
</script>

<style scoped lang="scss">
.k-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  // The glyph is the control's entire content, so the control's font-size IS its icon size:
  // a step of the icon scale, not of the type scale. `md` — the box is 28px and the mark has
  // no label anywhere near it to borrow meaning from.
  font-size: var(--k-icon-md);
  line-height: 1;
  cursor: pointer;
  border-radius: var(--k-r);
  transition: border-color 0.12s, color 0.12s;

  &:hover {
    border-color: var(--k-text);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }

  // In-flight action (e.g. a chat being turned into an agent): down until the server answers.
  &:disabled {
    cursor: default;
    opacity: 0.45;

    &:hover {
      border-color: var(--k-line);
      color: var(--k-muted);
    }
  }
}

// active — accent frame + glyph (e.g. a running preview toggle).
.k-icon-btn--on {
  border-color: var(--k-accent);
  color: var(--k-accent);
}
</style>
