// apps/ui/src/composables/useComposerDictation.ts
// Local dictation into a chat composer (docs/specs/2026-11-14-local-voice-dictation.md): every
// finished phrase lands at the composer's caret, and after a pause the message sends itself
// behind a visible countdown (decision 3); while the agent waits on a decision block, a phrase
// that answers it goes to the block instead (decision 8). The host side of KPanel — kit
// components do not talk to stores — so the panel hands its composer and its decision block
// over as a `ComposerDictationHost` and renders the `ComposerDictationState` this returns. The
// assistants' composer (AssistantComposer.vue, docs/specs/2026-11-18-assistant-voice-dictation.md)
// is a host too, with no decision block.
import { computed, nextTick, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  DICTATION_COMPOSER_IDLE_MS,
  DICTATION_SEND_MS,
  insertDictated,
  parseUiAnswer,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from '@kermanych/core';
import { useDictation } from '../stores/dictation';
import { useDictationStartError } from './useDictationField';

/** What a composer lends the dictation: its text and send, and its decision block if it has one. */
export type ComposerDictationHost = {
  /** The composer's text. */
  text: Ref<string>;
  field: () => HTMLTextAreaElement | null;
  /** The composer's own submit: the attached images ride along, the text is cleared. */
  send: () => void;
  /** False while the composer cannot send (the assistant's turn in flight): the countdown waits
   *  and starts once it is true again. Absent: always sendable. */
  sendable?: () => boolean;
  /** The decision block the agent waits on. */
  request: () => RpcExtensionUIRequest | undefined;
  /** Answers the decision block; an input / editor answer clears its field. */
  answer: (res: RpcExtensionUIResponse) => void;
  /** The decision block's own input / editor field. */
  blockText: Ref<string>;
  blockField: () => HTMLInputElement | HTMLTextAreaElement | null;
};

/** The composer dictation as the panel renders it; null while this composer does not dictate. */
export type ComposerDictationState = {
  /** `starting` = the engine warming and the microphone opening. */
  phase: 'starting' | 'live' | 'stopping';
  level: number;
  /** A phrase is being spoken. */
  hearing: boolean;
  /** Phrases sent to the recogniser whose text has not come back. */
  recognising: boolean;
  /** The auto-send running: when it fires, its whole length, and whether it answers the block. */
  countdown: { at: number; ms: number; answer: boolean } | null;
  /** The decision block's option (index) or button (yes / no) a phrase picked. */
  highlight: { option: number } | { confirmed: boolean } | null;
};

export type ComposerDictation = {
  state: ComputedRef<ComposerDictationState | null>;
  /** 🎤 / ⌥D: starts dictating into this composer, or stops it. */
  toggle: () => void;
  start: () => Promise<void>;
  stop: () => void;
  /** Stops at once: the panel is gone or shows another session. Inserted text stays. */
  cancel: () => void;
};

// A countdown the operator never sees cannot be cancelled: when the recogniser was slow and the
// text came back close to the send moment, the countdown still runs this long.
export const DICTATION_SEND_NOTICE_MS = 1000;

const BLOCK_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export function useComposerDictation(host: () => ComposerDictationHost | null): ComposerDictation {
  const dictation = useDictation();
  const startError = useDictationStartError();
  const me = Symbol('composer-dictation');
  const mine = () => dictation.owner === me;

  // What a pause would send. `…Held`: the operator edited that text by hand, so it waits for
  // their Enter (decision 3).
  let composerDue = false;
  let composerHeld = false;
  let blockDue = false;
  let blockHeld = false;
  // A select / confirm answer recognised and highlighted, sent with the countdown (decision 8).
  const blockAnswer = ref<RpcExtensionUIResponse | null>(null);
  const countdown = ref<ComposerDictationState['countdown']>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The values this composable wrote: any other change of the field is the operator's hand.
  let wroteText: string | null = null;
  let wroteBlock: string | null = null;

  function disarm(): void {
    clearTimeout(timer);
    timer = undefined;
    countdown.value = null;
  }

  // The dictated message is due once the composer can send it; until then it waits in the field.
  function composerReady(h: ComposerDictationHost): boolean {
    return composerDue && !composerHeld && !!h.text.value.trim() && (h.sendable?.() ?? true);
  }

  function anythingDue(h: ComposerDictationHost): boolean {
    return !!blockAnswer.value || (blockDue && !blockHeld && !!h.blockText.value.trim()) || composerReady(h);
  }

  // The countdown runs while there is something to send, nothing is being said and every phrase
  // already said is back as text. It ends DICTATION_SEND_MS after the last speech.
  function reconsider(): void {
    const h = host();
    const quiet = mine() && dictation.phase === 'live' && !dictation.speaking && dictation.transcribing === 0;
    if (!h || !quiet || !anythingDue(h)) return disarm();
    if (countdown.value) return;
    const now = Date.now();
    const at = Math.max(dictation.lastSpeechAt + DICTATION_SEND_MS, now + DICTATION_SEND_NOTICE_MS);
    countdown.value = { at, ms: at - now, answer: !!blockAnswer.value || (blockDue && !blockHeld) };
    timer = setTimeout(fire, at - now);
  }

  function restart(): void {
    disarm();
    reconsider();
  }

  function fire(): void {
    timer = undefined;
    countdown.value = null;
    const h = host();
    if (!h) return;
    const req = h.request();
    if (blockAnswer.value) {
      h.answer(blockAnswer.value);
      blockAnswer.value = null;
    } else if (blockDue && !blockHeld && req && h.blockText.value.trim()) {
      h.answer({ type: 'extension_ui_response', id: req.id, value: h.blockText.value.trim() });
    }
    blockDue = false;
    if (composerReady(h)) {
      composerDue = false;
      h.send();
    }
  }

  // The value is recorded as the dictation's own before it is written: the field watchers run
  // synchronously on the write and would otherwise take it for the operator's edit.
  function insertInto(sink: 'composer' | 'block', h: ComposerDictationHost, text: string): void {
    const target = sink === 'composer' ? h.text : h.blockText;
    const el = sink === 'composer' ? h.field() : h.blockField();
    const v = target.value;
    const out = insertDictated(v, el?.selectionStart ?? v.length, el?.selectionEnd ?? v.length, text);
    if (sink === 'composer') wroteText = out.value;
    else wroteBlock = out.value;
    target.value = out.value;
    // The caret follows the phrase, so the next one lands after it.
    void nextTick(() => el?.setSelectionRange(out.caret, out.caret));
  }

  // Each finished phrase, in speaking order.
  function onText(text: string): void {
    const h = host();
    if (!h) return;
    const req = h.request();
    if (req && BLOCK_METHODS.has(req.method)) {
      const res = parseUiAnswer(req, text);
      if (res && (req.method === 'select' || req.method === 'confirm')) {
        blockAnswer.value = res;
        return restart();
      }
      if (res) {
        insertInto('block', h, text);
        blockDue = true;
        return restart();
      }
    }
    insertInto('composer', h, text);
    composerDue = true;
    restart();
  }

  async function start(): Promise<void> {
    try {
      await dictation.start(me, { onText, idleMs: DICTATION_COMPOSER_IDLE_MS });
    } catch (e) {
      startError(e);
    }
  }

  function forget(): void {
    disarm();
    composerDue = false;
    blockDue = false;
    blockAnswer.value = null;
  }

  function stop(): void {
    // A second press while the last phrase is being flushed changes nothing.
    if (mine() && dictation.phase !== 'stopping') void dictation.stop();
  }

  function cancel(): void {
    if (mine()) dictation.cancel();
    forget();
  }

  // Esc anywhere cancels the send that is about to happen; the text stays (decision 3). Heard in
  // the capture phase and claimed, so a host's own Esc (closing «ЦТ», AssistantLauncher.vue) does
  // not act on the same press.
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !countdown.value) return;
    e.preventDefault();
    forget();
  }

  const sync = { flush: 'sync' } as const;
  watch([() => dictation.speaking, () => dictation.transcribing, () => dictation.phase, () => dictation.owner, () => dictation.lastSpeechAt], reconsider, sync);
  // The composer could not send (a turn in flight) and now can, or the other way round.
  watch(() => host()?.sendable?.() ?? true, reconsider, sync);
  // Not live any more (stopped, idle, another field took the microphone): nothing sends by
  // itself after that, and no option stays lit for an answer that will not go.
  watch(
    () => mine() && dictation.phase === 'live',
    (live) => {
      if (!live) forget();
    },
    sync,
  );
  watch(
    () => host()?.text.value,
    (v) => {
      if (v === undefined || v === wroteText) return;
      wroteText = null;
      // Emptied — sent with Enter or cleared: the next dictated text sends itself again.
      if (!v.trim()) {
        composerDue = false;
        composerHeld = false;
      } else composerHeld = true;
      reconsider();
    },
    sync,
  );
  watch(
    () => host()?.blockText.value,
    (v) => {
      if (v === undefined || v === wroteBlock) return;
      wroteBlock = null;
      if (!v.trim()) {
        blockDue = false;
        blockHeld = false;
      } else blockHeld = true;
      reconsider();
    },
    sync,
  );
  // The block answered by a click, or replaced by another question.
  watch(
    () => host()?.request()?.id,
    () => {
      blockAnswer.value = null;
      blockDue = false;
      blockHeld = false;
      reconsider();
    },
    sync,
  );
  // The panel unmounted (decision 14): the microphone closes, inserted text stays.
  watch(
    () => !!host(),
    (present) => {
      if (!present) cancel();
    },
    sync,
  );
  window.addEventListener('keydown', onWindowKeydown, true);
  onScopeDispose(() => {
    window.removeEventListener('keydown', onWindowKeydown, true);
    cancel();
  });

  const highlight = computed<ComposerDictationState['highlight']>(() => {
    const res = blockAnswer.value;
    if (!res) return null;
    if ('confirmed' in res) return { confirmed: res.confirmed };
    if (!('value' in res)) return null;
    const option = host()?.request()?.options?.indexOf(res.value) ?? -1;
    return option >= 0 ? { option } : null;
  });

  return {
    state: computed(() => {
      if (!mine() || dictation.phase === 'idle') return null;
      return {
        phase: dictation.phase,
        level: dictation.micLevel,
        hearing: dictation.speaking,
        recognising: dictation.transcribing > 0,
        countdown: countdown.value,
        highlight: highlight.value,
      };
    }),
    toggle: () => (mine() ? stop() : void start()),
    start,
    stop,
    cancel,
  };
}
