// apps/ui/src/composables/useDictationWords.ts
// The words of a composer's dictation line (docs/specs/2026-11-14-local-voice-dictation.md,
// decisions 3 and 6): what the microphone is doing, or the auto-send countdown in whole seconds.
// Shared by KComposer and AssistantComposer so both lines say the same thing. The clock ticks only
// while a countdown runs.
import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ComposerDictationState } from './useComposerDictation';

export function useDictationWords(state: () => ComposerDictationState | null | undefined): ComputedRef<string> {
  const { t } = useI18n();
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | undefined;
  watch(
    () => state()?.countdown?.at,
    (at) => {
      clearInterval(clock);
      clock = undefined;
      now.value = Date.now();
      if (at) clock = setInterval(() => (now.value = Date.now()), 100);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => clearInterval(clock));

  return computed(() => {
    const d = state();
    if (!d) return '';
    if (d.countdown) {
      const n = Math.max(1, Math.ceil((d.countdown.at - now.value) / 1000));
      return t(d.countdown.answer ? 'kit.composer.dictation.answerIn' : 'kit.composer.dictation.sendIn', { n });
    }
    if (d.phase === 'starting') return t('kit.composer.dictation.starting');
    if (d.phase === 'stopping' || d.recognising) return t('kit.composer.dictation.recognising');
    return t('kit.composer.dictation.listening');
  });
}
