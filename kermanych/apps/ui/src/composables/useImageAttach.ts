// apps/ui/src/composables/useImageAttach.ts
import { ref } from 'vue';
import { fileToImage, type AttachedImage } from '../lib/images';

// Shared image-attachment state for the message input and the launcher: collect
// images via paste, drag-drop, or file-pick, preview them, drop them, then read
// them out. Each host renders its own thumbnail strip from `images`.
export function useImageAttach() {
  const images = ref<AttachedImage[]>([]);
  const error = ref<string | null>(null);

  async function addFiles(files: Iterable<File | Blob>): Promise<void> {
    for (const file of files) {
      if (!file.type?.startsWith('image/')) continue;
      try {
        images.value = [...images.value, await fileToImage(file)];
        error.value = null;
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      }
    }
  }

  async function onPaste(e: ClipboardEvent): Promise<void> {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) {
      e.preventDefault();
      await addFiles(files);
    }
  }

  async function onDrop(e: DragEvent): Promise<void> {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) await addFiles(files);
  }

  function remove(idx: number): void {
    images.value = images.value.filter((_, i) => i !== idx);
  }
  function clear(): void {
    images.value = [];
    error.value = null;
  }

  return { images, error, addFiles, onPaste, onDrop, remove, clear };
}
