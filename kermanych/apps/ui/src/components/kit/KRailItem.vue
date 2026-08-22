<template>
  <button
    class="k-rail"
    :class="{ 'k-rail--active': active, 'k-rail--colored': !!group.color }"
    type="button"
    v-tip="group.name"
    :aria-label="group.name"
    :aria-pressed="active"
    :style="group.color ? { '--rail-color': group.color } : undefined"
  >
    <span class="k-rail__initials mono">{{ initials }}</span>
    <span v-if="count > 0" class="k-rail__count mono">{{ count }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Group } from '@kermanych/core';

// A project tile in the left rail (design-system section 07). Initials stand in
// for the group; the count badge is the number of running agents. Active tile
// gets surface2 and a 2px accent strip on the left edge.
const props = defineProps<{ group: Group; active?: boolean; count?: number }>();

const count = computed(() => props.count ?? 0);

const initials = computed(() => {
  const words = props.group.name.trim().split(/[\s/_-]+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '·';
  if (!second) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? '') + (second[0] ?? '')).toUpperCase();
});
</script>

<style scoped lang="scss">
.k-rail {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  border-radius: 0;
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  &:hover:not(.k-rail--active) {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// left strip — project color when set (always shown), else the accent when active.
.k-rail--active {
  background: var(--k-surface2);
  border-color: var(--k-line-strong);
  color: var(--k-text);
}

.k-rail--active::before,
.k-rail--colored::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--k-accent);
}

.k-rail--colored::before {
  background: var(--rail-color);
}

.k-rail__initials {
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.04em;
}

// count badge — accent square, top-right, machine number.
.k-rail__count {
  position: absolute;
  top: -1px;
  right: -1px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--k-canvas);
  background: var(--k-accent);
}
</style>
