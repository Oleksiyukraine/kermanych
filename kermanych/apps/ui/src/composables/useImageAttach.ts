// apps/ui/src/composables/useImageAttach.ts
import { ref } from 'vue';
import { fileToImage, type AttachedImage } from '../lib/images';

// Shared image-attachment state for the message input and the launcher: collect
// images via paste, drag-drop, or file-pick, preview them, drop them, then read
// them out. Each host renders its own thumbnail strip from `images`.
export function useImageAttach() {
  const images = ref<AttachedImage[]>([]);
  const error = ref<string | null>(null);
  // Files still being read (FileReader is async): a send in that window would go out without
  // them, so hosts keep their send disabled while this is above zero.
  const reading = ref(0);

  async function addFiles(files: Iterable<File | Blob>): Promise<void> {
    // Copy before the first await: a picker passes its live `input.files`, and the
    // caller's synchronous `input.value = ''` empties that FileList mid-loop, so
    // only the first of several picked images would land.
    const list = [...files].filter((f) => f.type?.startsWith('image/'));
    reading.value += list.length;
    for (const file of list) {
      try {
        images.value = [...images.value, await fileToImage(file)];
        error.value = null;
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        reading.value -= 1;
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

  return { images, error, reading, addFiles, onPaste, onDrop, remove, clear };
}
