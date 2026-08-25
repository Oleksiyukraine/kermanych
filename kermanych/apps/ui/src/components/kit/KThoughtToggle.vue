<template>
  <div class="k-thought-toggle">
    <button
      class="k-thought-toggle__row"
      type="button"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      <span class="k-thought-toggle__marker" :class="{ 'k-thought-toggle__marker--open': open }">▸</span>
      <span class="k-thought-toggle__label">{{ label }}</span>
    </button>
    <div v-if="open" class="k-thought-toggle__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// Collapsible reasoning trace. Collapsed row shows `▸ {label}`; the marker
// rotates when open to reveal the default-slot body.
withDefaults(
  defineProps<{
    label: string;
    open?: boolean;
  }>(),
  { open: false },
);

const emit = defineEmits<{ toggle: [] }>();
</script>

<style scoped lang="scss">
.k-thought-toggle {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.k-thought-toggle__row {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 0;
  background: transparent;
  border: none;
  color: var(--k-faint);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  cursor: pointer;
}

.k-thought-toggle__marker {
  display: inline-block;
  transition: transform 0.15s ease;
}

.k-thought-toggle__marker--open {
  transform: rotate(90deg);
}

.k-thought-toggle__label {
  color: var(--k-faint);
}

.k-thought-toggle__body {
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}
</style>
