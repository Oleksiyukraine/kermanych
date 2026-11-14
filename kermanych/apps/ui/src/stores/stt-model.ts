// apps/ui/src/stores/stt-model.ts
// The local recogniser's model on this machine (docs/specs/2026-11-14-local-voice-dictation.md,
// decision 5): absent, downloading with its progress, or ready. The api owns the download (it
// keeps running when the window reloads); the window follows it by polling while it runs, so
// Settings → «Голос» and a download started from a dictation toast show the same progress.
// The actions throw: the buttons that call them wrap them in `useAsyncAction`.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SttModelStatus } from '@kermanych/core';
import { api } from '../lib/api';

export const STT_POLL_MS = 500;

/** The model's size as the operator reads it, «874 МБ»: decimal megabytes, as the download sites show it. */
export function sttModelMegabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

export const useSttModel = defineStore('stt-model', () => {
  /** `null` until the api first answered. */
  const status = ref<SttModelStatus | null>(null);
  let poll: ReturnType<typeof setTimeout> | undefined;

  function apply(s: SttModelStatus): void {
    status.value = s;
    clearTimeout(poll);
    poll = undefined;
    // A failed poll stops polling; the next refresh or action starts it again.
    if (s.state === 'downloading') poll = setTimeout(() => void refresh().catch(() => {}), STT_POLL_MS);
  }

  async function refresh(): Promise<void> {
    apply(await api.sttModel());
  }

  /** Starts the download, or continues a broken one where it stopped (HTTP Range in the api). */
  async function download(): Promise<void> {
    apply(await api.sttDownload());
  }

  /** The files downloaded so far stay, for the next download to resume. */
  async function cancelDownload(): Promise<void> {
    apply(await api.sttCancelDownload());
  }

  async function remove(): Promise<void> {
    apply(await api.sttRemove());
  }

  return { status, refresh, download, cancelDownload, remove };
});
