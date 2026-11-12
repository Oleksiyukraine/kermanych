// apps/ui/src/composables/useVoicePanel.ts
// What a page hosting KPanel needs for the voice conversation (docs/specs/2026-11-02-voice-conversation.md):
// the bar state for the panel's session and the three handlers. «Агенти», «Чат» and «Синергія»
// share it so the three panels behave identically.
import { computed, type ComputedRef } from 'vue';
import type { Session } from '@kermanych/core';
import { useVoice } from '../stores/voice';
import { useOrchestrator } from '../stores/orchestrator';
import { confirmAction } from '../lib/confirm';
import { globalTr } from '../boot/i18n';
import type { VoiceBarState } from '../lib/voice';
import { useAsyncAction } from './useAsyncAction';

export type VoicePanel = {
  /** The bar state while the conversation is bound to the panel's session, else null. */
  bar: ComputedRef<VoiceBarState | null>;
  start: () => void;
  mute: () => void;
  end: () => void;
};

export function useVoicePanel(session: () => Session | null | undefined): VoicePanel {
  const voice = useVoice();
  const orchestrator = useOrchestrator();

  const bar = computed(() => {
    const s = session();
    return s && voice.sessionId === s.id ? voice.bar : null;
  });

  // One conversation per app (decision 8): starting here while another session holds it asks
  // first, naming the session that would lose it.
  const starting = useAsyncAction(async (s: Session) => {
    if (voice.sessionId && voice.sessionId !== s.id) {
      const other = orchestrator.sessions.find((x) => x.id === voice.sessionId);
      const ok = await confirmAction({
        title: globalTr.t('voice.switch.title'),
        message: globalTr.t('voice.switch.message', { name: other?.name ?? voice.sessionId }),
        confirmLabel: globalTr.t('voice.switch.confirm'),
      });
      if (!ok) return;
    }
    await voice.start(s.id);
  });

  return {
    bar,
    start: () => {
      const s = session();
      if (s) void starting.run(s);
    },
    mute: () => voice.toggleMute(),
    end: () => void voice.end(),
  };
}
