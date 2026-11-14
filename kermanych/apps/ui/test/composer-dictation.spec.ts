// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, ref, type EffectScope } from 'vue';
import { DICTATION_COMPOSER_IDLE_MS, DICTATION_PAUSE_MS, DICTATION_SEND_MS, type RpcExtensionUIRequest } from '@kermanych/core';

// Composer dictation (docs/specs/2026-11-14-local-voice-dictation.md, decisions 3, 8, 14) against
// a scripted dictation store: where each phrase lands, when the auto-send fires, and what stops it.

type StartOpts = { onText: (text: string) => void; idleMs?: number };
const store = reactive({
  phase: 'idle' as 'idle' | 'starting' | 'live' | 'stopping',
  owner: null as symbol | null,
  micLevel: 0,
  transcribing: 0,
  speaking: false,
  lastSpeechAt: 0,
  start: vi.fn<(who: symbol, opts: StartOpts) => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  cancel: vi.fn<() => void>(),
});
let onText: (text: string) => void = () => {};
vi.mock('../src/stores/dictation', () => ({ useDictation: () => store }));
const startError = vi.fn();
vi.mock('../src/composables/useDictationField', () => ({ useDictationStartError: () => startError }));

import { DICTATION_SEND_NOTICE_MS, useComposerDictation, type ComposerDictation, type ComposerDictationHost } from '../src/composables/useComposerDictation';

// The operator says a phrase: speech, the 800 ms pause that cuts it, the recogniser's answer.
async function say(text: string): Promise<void> {
  store.speaking = true;
  store.lastSpeechAt = Date.now();
  await vi.advanceTimersByTimeAsync(500);
  store.lastSpeechAt = Date.now();
  await vi.advanceTimersByTimeAsync(DICTATION_PAUSE_MS);
  store.speaking = false;
  store.transcribing++;
  await vi.advanceTimersByTimeAsync(300);
  store.transcribing--;
  onText(text);
}

// After `say`, the send is due DICTATION_SEND_MS after the last speech, of which 1100 ms passed.
const LEFT_MS = DICTATION_SEND_MS - DICTATION_PAUSE_MS - 300;

describe('composer dictation', () => {
  let scope: EffectScope;
  let dictation: ComposerDictation;
  let host: ComposerDictationHost;
  const request = ref<RpcExtensionUIRequest | undefined>();
  const send = vi.fn();
  const answer = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    Object.assign(store, { phase: 'idle', owner: null, micLevel: 0, transcribing: 0, speaking: false, lastSpeechAt: 0 });
    store.start.mockReset().mockImplementation(async (who, opts) => {
      store.owner = who;
      store.phase = 'live';
      onText = opts.onText;
    });
    store.stop.mockReset().mockImplementation(async () => {
      store.phase = 'idle';
      store.owner = null;
    });
    store.cancel.mockReset().mockImplementation(() => {
      store.phase = 'idle';
      store.owner = null;
    });
    startError.mockReset();
    send.mockReset();
    answer.mockReset();
    request.value = undefined;
    const text = ref('');
    const blockText = ref('');
    host = {
      text,
      field: () => null,
      // KComposer's submit: the message goes and the field clears.
      send: () => {
        send(text.value);
        text.value = '';
      },
      request: () => request.value,
      answer: (res) => {
        answer(res);
        if ('value' in res) blockText.value = '';
      },
      blockText,
      blockField: () => null,
    };
    scope = effectScope();
    dictation = scope.run(() => useComposerDictation(() => host))!;
    await dictation.start();
  });
  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
  });

  it('dictates with the composer idle limit and sends the text after the pause, behind a visible countdown', async () => {
    expect(store.start).toHaveBeenCalledWith(expect.any(Symbol), expect.objectContaining({ idleMs: DICTATION_COMPOSER_IDLE_MS }));
    await say('Додай кнопку.');
    expect(host.text.value).toBe('Додай кнопку.');
    expect(dictation.state.value?.countdown).toMatchObject({ answer: false });
    await vi.advanceTimersByTimeAsync(LEFT_MS - 100);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledWith('Додай кнопку.');
    expect(dictation.state.value?.countdown).toBeNull();
    // Dictation stays on after the send (decision 3).
    expect(dictation.state.value?.phase).toBe('live');
    await say('Ще одне.');
    await vi.advanceTimersByTimeAsync(LEFT_MS);
    expect(send).toHaveBeenLastCalledWith('Ще одне.');
  });

  it('shows the countdown at least DICTATION_SEND_NOTICE_MS when the text came back late', async () => {
    store.lastSpeechAt = Date.now() - DICTATION_SEND_MS;
    onText('Пізно.');
    expect(dictation.state.value?.countdown?.ms).toBe(DICTATION_SEND_NOTICE_MS);
    await vi.advanceTimersByTimeAsync(DICTATION_SEND_NOTICE_MS);
    expect(send).toHaveBeenCalledWith('Пізно.');
  });

  it('speaking again appends and restarts the countdown', async () => {
    await say('Перше.');
    await vi.advanceTimersByTimeAsync(LEFT_MS - 200);
    store.speaking = true;
    expect(dictation.state.value?.countdown).toBeNull();
    store.speaking = false;
    await say('Друге.');
    expect(host.text.value).toBe('Перше. Друге.');
    await vi.advanceTimersByTimeAsync(LEFT_MS - 100);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Перше. Друге.');
  });

  it('an edit by hand cancels the auto-send until the message is sent', async () => {
    await say('Додай кнопку.');
    host.text.value = 'Додай кнопку експорту.';
    expect(dictation.state.value?.countdown).toBeNull();
    await say('І тест.');
    await vi.advanceTimersByTimeAsync(DICTATION_SEND_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(host.text.value).toBe('Додай кнопку експорту. І тест.');
    // Enter: the composer sends and clears; the next dictated text sends itself again.
    host.send();
    send.mockReset();
    await say('Наступне.');
    await vi.advanceTimersByTimeAsync(LEFT_MS);
    expect(send).toHaveBeenCalledWith('Наступне.');
  });

  it('Esc cancels the send and keeps the text', async () => {
    await say('Додай кнопку.');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dictation.state.value?.countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(DICTATION_SEND_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(host.text.value).toBe('Додай кнопку.');
  });

  it('«другий» with a pending select lights option 2 and answers it after the countdown', async () => {
    request.value = { type: 'extension_ui_request', id: 'r1', method: 'select', options: ['Так', 'Ні, інакше', 'Пізніше'] };
    await say('другий');
    expect(host.text.value).toBe('');
    expect(dictation.state.value?.highlight).toEqual({ option: 1 });
    expect(dictation.state.value?.countdown).toMatchObject({ answer: true });
    await vi.advanceTimersByTimeAsync(LEFT_MS);
    expect(answer).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'r1', value: 'Ні, інакше' });
    expect(send).not.toHaveBeenCalled();
    expect(dictation.state.value?.highlight).toBeNull();
  });

  it('Esc drops a recognised answer', async () => {
    request.value = { type: 'extension_ui_request', id: 'r1', method: 'confirm' };
    await say('так');
    expect(dictation.state.value?.highlight).toEqual({ confirmed: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dictation.state.value?.highlight).toBeNull();
    await vi.advanceTimersByTimeAsync(DICTATION_SEND_MS * 2);
    expect(answer).not.toHaveBeenCalled();
  });

  it('a phrase that is not an answer goes to the composer', async () => {
    request.value = { type: 'extension_ui_request', id: 'r1', method: 'select', options: ['Так', 'Ні'] };
    await say('А що буде з тестами?');
    expect(host.text.value).toBe('А що буде з тестами?');
    expect(dictation.state.value?.highlight).toBeNull();
    await vi.advanceTimersByTimeAsync(LEFT_MS);
    expect(send).toHaveBeenCalledWith('А що буде з тестами?');
    expect(answer).not.toHaveBeenCalled();
  });

  it('an input request takes the phrase into its own field and submits it after the countdown', async () => {
    request.value = { type: 'extension_ui_request', id: 'r2', method: 'input' };
    await say('Назви гілку feature/export.');
    expect(host.blockText.value).toBe('Назви гілку feature/export.');
    expect(host.text.value).toBe('');
    await vi.advanceTimersByTimeAsync(LEFT_MS);
    expect(answer).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'r2', value: 'Назви гілку feature/export.' });
    expect(send).not.toHaveBeenCalled();
  });

  it('stopping cancels the pending send; the toggle stops and the start error is reported', async () => {
    await say('Додай кнопку.');
    dictation.toggle();
    expect(store.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DICTATION_SEND_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(host.text.value).toBe('Додай кнопку.');

    const err = new Error('stt_model_missing');
    store.start.mockRejectedValueOnce(err);
    await dictation.start();
    expect(startError).toHaveBeenCalledWith(err);
  });
});
