<template>
  <button
    class="k-nav-item"
    :class="{ 'k-nav-item--active': active, 'k-nav-item--stacked': hint }"
    type="button"
    v-tip="tip"
    :aria-label="tip"
    @click="emit('click')"
  >
    <span v-if="icon" class="k-nav-item__icon">
      <KIcon :name="icon" />
    </span>
    <span class="k-nav-item__text">
      <span class="k-nav-item__label">{{ label }}</span>
      <span v-if="hint" class="k-nav-item__hint">{{ hint }}</span>
    </span>
    <KCount v-if="count != null" :value="count" />
  </button>
</template>

<script setup lang="ts">
// A sidebar navigation row: optional leading mark, a label, an optional second
// line under it, and an optional trailing count pill. Active rows lift onto
// surface2 with full-strength text.
//
// The hint is what lets ONE row component serve both rails — the shell's buckets
// (label + count, one line) and the Менеджмент section rail (label + what the
// section holds). It only changes the row's height when it is passed, so the
// single-line callers are untouched.
//
// `tip` is for the minified rail, where the layout hides the label and the count with
// `display: none` — which takes them out of the accessibility tree too, leaving the button
// with no name at all. Set it to the label there and the mark gets both a tooltip and an
// accessible name; leave it unset while the label is visible, since a bubble repeating text
// already on screen is noise.
import KCount from './KCount.vue';
import KIcon, { type KIconName } from './KIcon.vue';

withDefaults(
  defineProps<{
    label: string;
    count?: number;
    active?: boolean;
    icon?: KIconName;
    hint?: string;
    tip?: string | undefined;
  }>(),
  { active: false },
);

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped lang="scss">
.k-nav-item {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  text-align: left;
  color: var(--k-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--k-r);
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}

.k-nav-item--active {
  color: var(--k-text);
  background: var(--k-surface2);
}

// Two lines need air the one-line row does not: at 8px the pair sits tighter to
// its neighbours than the two lines sit to each other, and the rail reads as
// stripes rather than as rows.
.k-nav-item--stacked {
  padding: var(--k-sp-3);
}

.k-nav-item__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

// The label column. A single child collapses to exactly the old one-line box, so
// nothing moves for the rows that pass no hint.
.k-nav-item__text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.k-nav-item__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Never the thing you read first: one step down in size, one step down in colour.
// It stays quiet on the active row too — the label is what the fill promotes.
.k-nav-item__hint {
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-regular);
  color: var(--k-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
