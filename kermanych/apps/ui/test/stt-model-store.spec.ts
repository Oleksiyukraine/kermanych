// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SttModelStatus } from '@kermanych/core';

// The local recogniser's model (docs/specs/2026-11-14-local-voice-dictation.md, decision 5): the
// window follows a download the api runs by polling, and stops once it is over.

const sttModel = vi.fn<() => Promise<SttModelStatus>>();
const sttDownload = vi.fn<() => Promise<SttModelStatus>>();
const sttCancelDownload = vi.fn<() => Promise<SttModelStatus>>();
vi.mock('../src/lib/api', () => ({
  api: {
    sttModel: () => sttModel(),
    sttDownload: () => sttDownload(),
    sttCancelDownload: () => sttCancelDownload(),
  },
}));

import { STT_POLL_MS, sttModelMegabytes, useSttModel } from '../src/stores/stt-model';

const TOTAL = 874_188_075;
const status = (state: SttModelStatus['state'], receivedBytes?: number): SttModelStatus => ({
  engine: 'whisper',
  totalBytes: TOTAL,
  state,
  ...(receivedBytes === undefined ? {} : { receivedBytes }),
});

describe('the stt model store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sttModel.mockReset();
    sttDownload.mockReset();
    sttCancelDownload.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('polls while the model downloads and stops once it is ready', async () => {
    const s = useSttModel();
    sttDownload.mockResolvedValue(status('downloading', 0));
    await s.download();
    expect(s.status?.state).toBe('downloading');

    sttModel.mockResolvedValueOnce(status('downloading', 400_000_000)).mockResolvedValueOnce(status('ready'));
    await vi.advanceTimersByTimeAsync(STT_POLL_MS);
    expect(s.status?.receivedBytes).toBe(400_000_000);
    await vi.advanceTimersByTimeAsync(STT_POLL_MS);
    expect(s.status?.state).toBe('ready');

    await vi.advanceTimersByTimeAsync(STT_POLL_MS * 4);
    expect(sttModel).toHaveBeenCalledTimes(2);
  });

  it('a cancelled download stops polling', async () => {
    const s = useSttModel();
    sttDownload.mockResolvedValue(status('downloading', 0));
    await s.download();
    sttCancelDownload.mockResolvedValue(status('absent', 100_000_000));
    await s.cancelDownload();
    await vi.advanceTimersByTimeAsync(STT_POLL_MS * 4);
    expect(sttModel).not.toHaveBeenCalled();
    expect(s.status).toMatchObject({ state: 'absent', receivedBytes: 100_000_000 });
  });

  it('a ready model is not polled', async () => {
    const s = useSttModel();
    sttModel.mockResolvedValue(status('ready'));
    await s.refresh();
    await vi.advanceTimersByTimeAsync(STT_POLL_MS * 4);
    expect(sttModel).toHaveBeenCalledOnce();
  });

  it('shows the size in decimal megabytes, as download sites do', () => {
    expect(sttModelMegabytes(TOTAL)).toBe(874);
  });
});
