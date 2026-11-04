// apps/ui/src/composables/useFileAttach.ts
import { ref } from 'vue';
import { globalTr } from '../boot/i18n';
import { fileToAttachment, type AttachedFile } from '../lib/files';

// Shared attachment state for a composer that takes files beyond images (the management
// chat): collect files via paste, drag-drop, or file-pick, preview them, drop them, then
// read them out. The image-only twin is useImageAttach — agent sessions take only what
// omp's image slots carry, so the two stay separate composables rather than one with a
// flag. `imagesOnly` is for a composer that shares this one's strip but whose model has no
// file tools to open a document with (ЦУК): a document is refused with a line that says so.
export function useFileAttach(opts: { imagesOnly?: boolean } = {}) {
  const files = ref<AttachedFile[]>([]);
  const error = ref<string | null>(null);

  async function addFiles(list: Iterable<File>): Promise<void> {
    // Copy before the first await: a picker passes its live `input.files`, and the
    // caller's synchronous `input.value = ''` empties that FileList mid-loop.
    for (const file of [...list]) {
      try {
        const attached = await fileToAttachment(file);
        if (opts.imagesOnly && !attached.mimeType.startsWith('image/')) {
          error.value = globalTr.t('errors.file.imagesOnly', { name: file.name });
          continue;
        }
        files.value = [...files.value, attached];
        error.value = null;
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      }
    }
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    const picked = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (picked.length) {
      e.preventDefault();
      await addFiles(picked);
    }
  }

  async function onDrop(e: DragEvent): Promise<void> {
    const dropped = [...(e.dataTransfer?.files ?? [])];
    if (dropped.length) await addFiles(dropped);
  }

  function remove(idx: number): void {
    files.value = files.value.filter((_, i) => i !== idx);
  }
  function clear(): void {
    files.value = [];
    error.value = null;
  }

  return { files, error, addFiles, onPaste, onDrop, remove, clear };
}
