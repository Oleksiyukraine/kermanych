<template>
  <label class="k-select">
    <span v-if="label" class="k-select__label">{{ label }}</span>
    <select
      class="k-select__input"
      :value="modelValue ?? ''"
      :disabled="disabled"
      @change="onChange"
    >
      <option v-if="placeholder !== undefined" value="">{{ placeholder }}</option>
      <option v-for="opt in mergedOptions" :key="opt" :value="opt">{{ opt }}</option>
    </select>
  </label>
</template>

<script setup lang="ts">
import { computed } from 'vue';

// Native select styled like KField: label above, surface input, accent focus ring. Radius 0.
// The current value is always kept as an option so a stale selection still renders.
const props = defineProps<{
  label?: string;
  modelValue?: string;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const mergedOptions = computed(() => {
  const v = props.modelValue;
  return v && !props.options.includes(v) ? [v, ...props.options] : props.options;
});

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<style scoped lang="scss">
.k-select {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.k-select__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
}

.k-select__input {
  font-family: var(--k-font-mono);
  font-size: 13px;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: 0;
  outline: none;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;

  &:focus {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
</style>
