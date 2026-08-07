<template>
  <label class="k-field">
    <span v-if="label" class="k-field__label">{{ label }}</span>
    <input
      class="k-field__input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
  </label>
</template>

<script setup lang="ts">
// Text field: flush-left label above, surface input, accent focus ring. Radius 0.
defineProps<{
  label?: string;
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}
</script>

<style scoped lang="scss">
.k-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.k-field__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
}

.k-field__input {
  font-family: var(--k-font-mono);
  font-size: 13px;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: 0;
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;

  &::placeholder {
    color: var(--k-muted);
  }

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
