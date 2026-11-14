<template>
  <div class="k-dc" :class="{ 'k-dc--on': state !== 'idle' }">
    <!-- `mousedown.prevent`: the field keeps the focus and its caret, so the dictated phrase lands
         where the operator was typing and ⌥D keeps working. -->
    <button
      type="button"
      class="k-dc__btn mono"
      v-tip="state === 'idle' ? t('kit.dictate.startTip') : t('kit.dictate.stopTip')"
      :aria-pressed="state !== 'idle'"
      :aria-busy="state === 'starting' || state === 'stopping'"
      :disabled="disabled"
      @mousedown.prevent
      @click="emit('toggle')"
    >
      <KSpinner v-if="state === 'starting' || state === 'stopping'" :size="12" />
      <KIcon v-else class="k-dc__icon" name="mic" />
      <span>{{ state === 'idle' ? t('kit.dictate.start') : t('kit.dictate.stop') }}</span>
    </button>
    <template v-if="state !== 'idle'">
      <!-- What happens to the phrase now («слухаю…», «розпізнаю…»), else the state itself. Text
           appears in the field only once a phrase is recognised, never word by word. -->
      <span class="k-dc__state mono" role="status" aria-live="polite">{{ caption || t(`kit.dictate.state.${state}`) }}</span>
      <!-- The microphone's loudness: speech fills it. -->
      <span class="k-dc__level" aria-hidden="true">
        <span class="k-dc__level-fill" :style="{ transform: `scaleX(${level})` }"></span>
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
// Voice dictation under a task description (docs/specs/2026-11-14-local-voice-dictation.md,
// decision 6): the toggle, and while it runs the status of the phrase being spoken and the mic
// level. Pure presentation — the host passes the state of composables/useDictationField.ts in.
// Kept outside the field's <label>: a button inside one would be the label's control, and a
// click on the label text would toggle dictation.
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';
import KSpinner from './KSpinner.vue';

defineProps<{
  state: 'idle' | 'starting' | 'live' | 'stopping';
  /** The phrase's status line; empty shows the state's own word. */
  caption: string;
  level: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-dc {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  font-size: 12px;
}
.k-dc__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px;
  background: transparent;
  border: none;
  font-size: 11px;
  color: var(--k-muted);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--k-text);
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 2px;
  }
}
.k-dc--on .k-dc__btn,
.k-dc--on .k-dc__btn:hover:not(:disabled) {
  color: var(--k-accent);
}
.k-dc__icon {
  --k-icon-size: var(--k-icon-sm);
}
.k-dc__state {
  flex: none;
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}
.k-dc__level {
  flex: none;
  align-self: center;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: var(--k-line);
  overflow: hidden;
}
.k-dc__level-fill {
  display: block;
  height: 100%;
  background: var(--k-accent);
  transform-origin: left center;
  transition: transform 120ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .k-dc__level-fill {
    transition: none;
  }
}
</style>
