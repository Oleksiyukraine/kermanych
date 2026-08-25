<template>
  <q-dialog
    :model-value="modelValue"
    :persistent="persistent"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="k-modal" :class="{ 'k-modal--flush': flush }" :style="width ? { width } : undefined">
      <header class="k-modal__head">
        <h3 class="k-modal__title">{{ title }}</h3>
        <slot name="head-meta" />
      </header>

      <div class="k-modal__body" :class="{ 'k-modal__body--flush': flush }">
        <slot />
      </div>

      <footer v-if="$slots.controls" class="k-modal__controls">
        <slot name="controls" />
      </footer>
    </div>
  </q-dialog>
</template>

<script setup lang="ts">
import { QDialog } from 'quasar';

// The only shadowed layer in the system. QDialog supplies the overlay/backdrop
// mechanics; the panel itself is styled with tokens (1px border, 2px rule under
// the title, 1px rule above the controls).
defineProps<{ modelValue: boolean; title: string; persistent?: boolean; width?: string; flush?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<style scoped lang="scss">
.k-modal {
  width: 440px;
  max-width: 92vw;
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  color: var(--k-text);
}

.k-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 22px;
  border-bottom: 2px solid var(--k-line-strong); // 2px rule under title
}

.k-modal__title {
  margin: 0;
  text-align: left; // headings flush-left
  font-family: var(--k-font-ui);
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.k-modal__body {
  padding: 22px;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.65;
  color: var(--k-muted);
}

// Flush body: the consumer supplies its own full-bleed layout (e.g. the
// two-column task launcher), so drop the default padding and muted body text.
.k-modal__body--flush {
  padding: 0;
  color: var(--k-text);
  font-size: 13px;
  line-height: 1.65;
}

.k-modal__controls {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px;
  border-top: 1px solid var(--k-line); // 1px rule above actions
}
</style>
