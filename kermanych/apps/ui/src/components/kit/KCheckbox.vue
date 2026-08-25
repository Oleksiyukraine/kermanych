<template>
  <label class="k-checkbox">
    <input
      class="k-checkbox__box"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <span v-if="label" class="k-checkbox__label">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
// Checkbox: token-styled native input, radius 0, accent fill when checked.
defineProps<{ modelValue?: boolean; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked);
}
</script>

<style scoped lang="scss">
.k-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--k-font-ui);
  font-size: 13px;
  color: var(--k-text);
  cursor: pointer;
  user-select: none;
}
.k-checkbox__box {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid var(--k-line-strong);
  background: var(--k-surface);
  border-radius: var(--k-r);
  display: grid;
  place-content: center;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.k-checkbox__box:checked {
  background: var(--k-accent);
  border-color: var(--k-accent);
}
.k-checkbox__box:checked::after {
  content: '';
  width: 4px;
  height: 8px;
  border: solid var(--k-canvas);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}
.k-checkbox__box:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
