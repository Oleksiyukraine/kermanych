// apps/ui/src/composables/useVoicePanel.ts
// What a page hosting KPanel needs for voice: the Live conversation
// (docs/specs/2026-11-02-voice-conversation.md) and local dictation into the panel's composer
// (docs/specs/2026-11-14-local-voice-dictation.md). «Агенти», «Дослідження» and «Синергія» share it so
// the three panels behave identically; «Синергія» offers dictation only (decision 1).
import { computed, watch, type ComputedRef, type Ref } from 'vue';
import type { Session } from '@kermanych/core';
import { useVoice } from '../stores/voice';
import { useOrchestrator } from '../stores/orchestrator';
import { confirmAction } from '../lib/confirm';
import { persisted } from '../lib/persisted';
import { globalTr } from '../boot/i18n';
import type { VoiceBarState } from '../lib/voice';
import { useAsyncAction } from './useAsyncAction';
import { useComposerDictation, type ComposerDictationHost, type ComposerDictationState } from './useComposerDictation';

export type VoiceMode = 'dictation' | 'live';

// Decision 2: the 🎤 button starts the mode used last on this machine; dictation by default, so
// the paid mode never starts by accident.
export const voiceModePick: Ref<VoiceMode> = persisted(
  'kermanych.voice.mode',
  'dictation',
  (raw) => (raw === 'dictation' || raw === 'live' ? raw : null),
  (v) => v,
);

export type VoicePanel = {
  /** The bar state while the conversation is bound to the panel's session, else null. */
  bar: ComputedRef<VoiceBarState | null>;
  /** The composer dictation's state while this panel dictates, else null. */
  dictation: ComputedRef<ComposerDictationState | null>;
  /** The host offers Live beside dictation: the 🎤 has the ▾ mode menu. */
  live: boolean;
  /** The mode the 🎤 click starts. */
  mode: ComputedRef<VoiceMode>;
  /** 🎤 click: stops the running dictation, else starts the remembered mode. */
  start: () => void;
  /** A pick in the ▾ menu: remembered, then started. */
  pick: (mode: VoiceMode) => void;
  /** ⌥D in the composer (decision 13). */
  toggleDictation: () => void;
  mute: () => void;
  end: () => void;
};

export function useVoicePanel(
  session: () => Session | null | undefined,
  opts: { live: boolean; composer: () => ComposerDictationHost | null | undefined },
): VoicePanel {
  const voice = useVoice();
  const orchestrator = useOrchestrator();
  const composer = useComposerDictation(() => opts.composer() ?? null);

  const bar = computed(() => {
    const s = session();
    return s && voice.sessionId === s.id ? voice.bar : null;
  });
  const mode = computed<VoiceMode>(() => (opts.live ? voiceModePick.value : 'dictation'));

  // One conversation per app (decision 8 of the voice-conversation spec): starting here while
  // another session holds it asks first, naming the session that would lose it.
  const startingLive = useAsyncAction(async (s: Session) => {
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

  function startMode(m: VoiceMode): void {
    const s = session();
    if (!s) return;
    if (m === 'live') {
      composer.cancel();
      void startingLive.run(s);
      return;
    }
    // Switching this panel from Live to dictation ends the conversation it holds.
    if (bar.value) void voice.end();
    void composer.start();
  }

  // Another session shown in the same panel: dictation meant for one agent never sends itself to
  // another.
  watch(
    () => session()?.id,
    () => composer.cancel(),
  );

  return {
    bar,
    dictation: composer.state,
    live: opts.live,
    mode,
    start: () => {
      if (composer.state.value) return composer.stop();
      startMode(mode.value);
    },
    pick: (m) => {
      voiceModePick.value = m;
      // The picked mode already runs here: nothing to start.
      if (m === 'dictation' ? composer.state.value : bar.value) return;
      startMode(m);
    },
    toggleDictation: composer.toggle,
    mute: () => voice.toggleMute(),
    end: () => void voice.end(),
  };
}
