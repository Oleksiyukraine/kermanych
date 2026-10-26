<template>
  <div class="k-tabs">
    <div class="k-tabs__list" role="tablist">
      <!-- The item carries the underline, so a tab's ✕ sits on it with the label. The ✕ is a
           sibling of the tab, not inside it: a button may not hold another one. -->
      <div
        v-for="tab in tabs"
        :key="tab.value"
        class="k-tabs__item"
        :class="{ 'k-tabs__item--active': tab.value === modelValue }"
        role="presentation"
      >
        <button
          class="k-tabs__tab"
          type="button"
          role="tab"
          :aria-selected="tab.value === modelValue"
          @click="emit('update:modelValue', tab.value)"
        >
          {{ tab.label }}
          <span v-if="tab.count != null && tab.count > 0" class="k-tabs__count mono">{{ tab.count }}</span>
          <span v-if="tab.live" class="k-tabs__live" aria-hidden="true"></span>
        </button>
        <button
          v-if="tab.closeLabel"
          v-tip="tab.closeLabel"
          class="k-tabs__close"
          type="button"
          :aria-label="tab.closeLabel"
          @click="emit('close', tab.value)"
        >✕</button>
      </div>
    </div>
    <!-- Trailing controls (e.g. the log's expand/collapse pair), right-aligned on the tab
         row's baseline. Kept out of the tablist so screen readers see only tabs there. -->
    <div v-if="$slots.end" class="k-tabs__end">
      <slot name="end" />
    </div>
  </div>
</template>

<script setup lang="ts">
// Underline tabs. Active tab carries the vermilion 2px underline and full-text
// color; inactive tabs are muted and brighten on hover. A tab MAY carry a `count`
// badge (the changed-file / worktree-file tallies), a pulsing `live` dot (something is acting
// in that tab right now — the agent driving the session browser), and a ✕ when it has a
// `closeLabel` (its tooltip and accessible name; pressing it emits `close` with the tab's
// value and leaves the selection alone). The row MAY host trailing controls through the
// `end` slot.
defineProps<{
  modelValue: string;
  tabs: { value: string; label: string; count?: number; live?: boolean; closeLabel?: string }[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  close: [value: string];
}>();
</script>

<style scoped lang="scss">
.k-tabs {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--k-sp-4);
  border-bottom: 1px solid var(--k-line);
}

.k-tabs__list {
  display: flex;
  gap: var(--k-sp-4);
  min-width: 0;
}

.k-tabs__item {
  display: inline-flex;
  align-items: baseline;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: border-color 0.12s;
}

.k-tabs__item--active {
  border-bottom-color: var(--k-accent);

  .k-tabs__tab {
    color: var(--k-text);
  }
}

.k-tabs__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  padding: var(--k-sp-3) 0;
  border: none;
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// A glyph beside the label, quieter than it: `xs` is the icon scale's floor, below which a ✕
// stops reading as a cross (KAttachStrip).
.k-tabs__close {
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  padding: 0;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-faint);
  font-size: var(--k-icon-xs);
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s;

  &:hover {
    color: var(--k-accent);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// The count rides a step down the type scale and stays muted even on the active tab: it is
// a tally beside the label, not part of it.
.k-tabs__count {
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-regular);
  color: var(--k-faint);
}

.k-tabs__live {
  align-self: center;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k-accent);
  animation: k-tabs-live 1.2s ease-in-out infinite;
}

@keyframes k-tabs-live {
  50% { opacity: 0.3; }
}

.k-tabs__end {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  flex: none;
  // Clears the 1px the active tab's underline is pulled down onto, so trailing controls sit
  // on the labels' baseline rather than on the rule.
  padding-bottom: var(--k-sp-3);
}
</style>
