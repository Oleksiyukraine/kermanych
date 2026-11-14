// apps/ui/src/composables/useDictationField.ts
// What a task popup wires for voice dictation (docs/specs/2026-11-03-voice-dictation.md, on the
// local recogniser since docs/specs/2026-11-14-local-voice-dictation.md): the 🎤 state and status
// line for its description field, the toggle (button and ⌥D), and the two hooks its submit and
// close paths call. Every finished phrase lands at the field's caret; the field stays editable
// meanwhile.
import { computed, nextTick, onBeforeUnmount, type ComputedRef, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { insertDictated } from '@kermanych/core';
import { useDictation, type DictationPhase } from '../stores/dictation';
import { useOrchestrator } from '../stores/orchestrator';
import { sttModelMegabytes, useSttModel } from '../stores/stt-model';
import { ApiError } from '../lib/api';
import { globalTr } from '../boot/i18n';
import { errorText, useAsyncAction } from './useAsyncAction';

export type DictationField = {
  /** This field's dictation state; `idle` while another field (or none) dictates. */
  state: ComputedRef<DictationPhase>;
  /** What happens to the phrase now — «слухаю…» while it is spoken, «розпізнаю…» while the
   *  recogniser works on it (decision 6); text appears only once a phrase is finished. */
  caption: ComputedRef<string>;
  level: ComputedRef<number>;
  toggle: () => void;
  /** The submit path: lets the last phrase land before the field is read. */
  beforeSubmit: () => Promise<void>;
  /** The close path: stops at once, an unfinished phrase is lost. */
  cancel: () => void;
  /** ⌥D on the field toggles dictation. */
  onKeydown: (e: KeyboardEvent) => void;
};

/**
 * Words a failed `useDictation().start` for the operator. Decision 5: without the model,
 * dictation is unavailable and the toast offers to download it — and opens Settings → «Голос»,
 * where its progress shows. Call in setup; the returned function takes what `start` threw.
 */
export function useDictationStartError(): (e: unknown) => void {
  const orchestrator = useOrchestrator();
  const router = useRouter();
  const model = useSttModel();
  const download = useAsyncAction(() => model.download());

  async function show(e: unknown): Promise<void> {
    if (!(e instanceof ApiError && e.code === 'stt_model_missing')) return orchestrator.notify(errorText(e), 'error');
    // The size in the button's label; without an answer the label goes without it.
    if (!model.status) await model.refresh().catch(() => {});
    const total = model.status?.totalBytes;
    orchestrator.notify(errorText(e), 'error', 10_000, {
      label: total
        ? globalTr.t('dictation.downloadModelSize', { size: sttModelMegabytes(total) })
        : globalTr.t('dictation.downloadModel'),
      run: () => {
        void download.run();
        void router.push({ name: 'settings', params: { section: 'app-voice' } });
      },
    });
  }

  return (e) => void show(e);
}

export function useDictationField(opts: {
  el: () => HTMLTextAreaElement | HTMLInputElement | null | undefined;
  value: Ref<string>;
}): DictationField {
  const dictation = useDictation();
  const startError = useDictationStartError();
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
      // A popup keeps the default minute of silence (decision 14).
      await dictation.start(me, { onText: insert });
    } catch (e) {
      startError(e);
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
    caption: computed(() => {
      if (!mine()) return '';
      if (dictation.speaking) return globalTr.t('dictation.listening');
      return dictation.transcribing > 0 ? globalTr.t('dictation.recognising') : '';
    }),
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
