// apps/ui/src/composables/useFileAttach.ts
import { ref } from 'vue';
import { fileToAttachment, type AttachedFile } from '../lib/files';

// Shared attachment state for a composer that takes files beyond images (the management
// chat): collect files via paste, drag-drop, or file-pick, preview them, drop them, then
// read them out. The image-only twin is useImageAttach — agent sessions take only what
// omp's image slots carry, so the two stay separate composables rather than one with a
// flag.
export function useFileAttach() {
  const files = ref<AttachedFile[]>([]);
  const error = ref<string | null>(null);

  async function addFiles(list: Iterable<File>): Promise<void> {
    for (const file of list) {
      try {
        files.value = [...files.value, await fileToAttachment(file)];
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
