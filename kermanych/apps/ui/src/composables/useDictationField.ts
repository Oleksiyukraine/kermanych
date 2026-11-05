// apps/ui/src/composables/useDictationField.ts
// What a task popup wires for voice dictation (docs/specs/2026-11-03-voice-dictation.md): the
// 🎤 state and draft caption for its description field, the toggle (button and ⌥D), and the two
// hooks its submit and close paths call. Every finished phrase lands at the field's caret
// (decision 4); the field stays editable meanwhile.
import { computed, nextTick, onBeforeUnmount, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { insertDictated } from '@kermanych/core';
import { useDictation, type DictationPhase } from '../stores/dictation';
import { useOrchestrator } from '../stores/orchestrator';
import { ApiError } from '../lib/api';
import { globalTr } from '../boot/i18n';
import { errorText } from './useAsyncAction';

export type DictationField = {
  /** This field's dictation state; `idle` while another field (or none) dictates. */
  state: ComputedRef<DictationPhase>;
  /** The phrase being recognised, not yet in the field. */
  caption: ComputedRef<string>;
  level: ComputedRef<number>;
  toggle: () => void;
  /** The submit path: lets the last phrase land before the field is read (decision 6.2). */
  beforeSubmit: () => Promise<void>;
  /** The close path: stops at once, an unfinished phrase is lost (decision 6.3). */
  cancel: () => void;
  /** ⌥D on the field toggles dictation. */
  onKeydown: (e: KeyboardEvent) => void;
};

export function useDictationField(opts: {
  el: () => HTMLTextAreaElement | HTMLInputElement | null | undefined;
  value: Ref<string>;
}): DictationField {
  const dictation = useDictation();
  const orchestrator = useOrchestrator();
  const router = useRouter();
  const me = Symbol('dictation-field');
  const mine = () => dictation.owner === me;

  function insert(text: string): void {
    const el = opts.el();
    const v = opts.value.value;
    const out = insertDictated(v, el?.selectionStart ?? v.length, el?.selectionEnd ?? v.length, text);
    opts.value.value = out.value;
    void nextTick(() => opts.el()?.setSelectionRange(out.caret, out.caret));
  }

  async function start(): Promise<void> {
    try {
      await dictation.start(me, insert);
    } catch (e) {
      // Decision 6.6: no key is a pointer to where it goes, not a dead end.
      const noKey = e instanceof ApiError && e.code === 'voice_key_missing';
      orchestrator.notify(
        errorText(e),
        'error',
        noKey ? 8000 : 4000,
        noKey
          ? { label: globalTr.t('dictation.openSettings'), run: () => void router.push({ name: 'settings', params: { section: 'app-voice' } }) }
          : undefined,
      );
    }
  }

  function toggle(): void {
    if (!mine()) return void start();
    // A second press while the last phrase is being flushed changes nothing.
    if (dictation.phase !== 'stopping') void dictation.stop();
  }

  function cancel(): void {
    if (mine()) dictation.cancel();
  }

  onBeforeUnmount(cancel);

  return {
    state: computed(() => (mine() ? dictation.phase : 'idle')),
    caption: computed(() => (mine() ? dictation.caption : '')),
    level: computed(() => (mine() ? dictation.micLevel : 0)),
    toggle,
    beforeSubmit: async () => {
      if (mine()) await dictation.stop();
    },
    cancel,
    onKeydown: (e) => {
      // `code`, not `key`: on macOS ⌥D types «∂».
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.code !== 'KeyD') return;
      e.preventDefault();
      toggle();
    },
  };
}
