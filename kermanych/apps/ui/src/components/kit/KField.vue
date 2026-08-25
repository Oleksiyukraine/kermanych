<template>
  <label class="k-field">
    <span v-if="label" class="k-field__label">{{ label }}</span>
    <textarea
      v-if="multiline"
      ref="inputEl"
      class="k-field__input k-field__input--multiline"
      :rows="rows ?? 4"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
    <input
      v-else
      ref="inputEl"
      class="k-field__input"
      :type="type ?? 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
  </label>
</template>

<script setup lang="ts">
import { ref } from 'vue';

// Text field: flush-left label above, surface input, accent focus ring. Radius 0.
// `multiline` swaps the <input> for a resizable <textarea> sharing the same surface styling.
defineProps<{
  label?: string;
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  multiline?: boolean;
  rows?: number;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const inputEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement | HTMLTextAreaElement).value);
}

defineExpose({ focus: () => inputEl.value?.focus() });
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
  border-radius: var(--k-r);
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

.k-field__input--multiline {
  resize: vertical;
  min-height: 72px;
  line-height: 1.5;
}
</style>
