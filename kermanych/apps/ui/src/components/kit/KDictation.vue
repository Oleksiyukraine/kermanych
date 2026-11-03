<template>
  <div class="k-dc" :class="{ 'k-dc--on': state !== 'idle' }">
    <!-- `mousedown.prevent`: the field keeps the focus and its caret, so the dictated phrase lands
         where the operator was typing and ⌥D keeps working. -->
    <button
      type="button"
      class="k-dc__btn mono"
      v-tip="state === 'idle' ? t('kit.dictate.startTip') : t('kit.dictate.stopTip')"
      :aria-pressed="state !== 'idle'"
      :aria-busy="state === 'connecting' || state === 'stopping'"
      :disabled="disabled"
      @mousedown.prevent
      @click="emit('toggle')"
    >
      <KSpinner v-if="state === 'connecting' || state === 'stopping'" :size="12" />
      <KIcon v-else class="k-dc__icon" name="mic" />
      <span>{{ state === 'idle' ? t('kit.dictate.start') : t('kit.dictate.stop') }}</span>
    </button>
    <template v-if="state !== 'idle'">
      <span class="k-dc__state mono" role="status" aria-live="polite">{{ t(`kit.dictate.state.${state}`) }}</span>
      <!-- The microphone's loudness: speech fills it. -->
      <span class="k-dc__level" aria-hidden="true">
        <span class="k-dc__level-fill" :style="{ transform: `scaleX(${level})` }"></span>
      </span>
      <!-- The phrase being recognised: a draft; only its final text goes into the field. -->
      <span class="k-dc__caption">{{ tail }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
// Voice dictation under a task description (docs/specs/2026-11-03-voice-dictation.md): the
// toggle, and while it runs the state, the mic level and the draft of the phrase being spoken
// (decision 4). Pure presentation — the host passes the state of
// composables/useDictationField.ts in. Kept outside the field's <label>: a button inside one
// would be the label's control, and a click on the label text would toggle dictation.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';
import KSpinner from './KSpinner.vue';

const props = defineProps<{
  state: 'idle' | 'connecting' | 'live' | 'stopping';
  caption: string;
  level: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();

// A long phrase shows its end — the words being said now.
const TAIL_CHARS = 140;
const tail = computed(() => (props.caption.length > TAIL_CHARS ? `…${props.caption.slice(-TAIL_CHARS)}` : props.caption));
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
.k-dc__caption {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--k-muted);
  font-style: italic;
}
@media (prefers-reduced-motion: reduce) {
  .k-dc__level-fill {
    transition: none;
  }
}
</style>
