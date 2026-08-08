// apps/ui/src/lib/images.ts
// Client-side image loading for chat/launcher attachments.

// omp accepts PNG/JPEG/GIF/WebP up to 20 MiB (see omp tools/inspect_image.md).
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// A pasted/dropped/picked image: `data`+`mimeType` feed the RPC (raw base64),
// `url` (data URL) renders the thumbnail and the transcript echo, `name` labels it.
export type AttachedImage = { data: string; mimeType: string; url: string; name: string };

// Read a File/Blob into an AttachedImage; throws on unsupported type or oversize.
export async function fileToImage(file: File | Blob): Promise<AttachedImage> {
  const mimeType = file.type;
  if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error(`непідтримуваний тип: ${mimeType || 'невідомо'} (треба PNG/JPEG/GIF/WebP)`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`завелике зображення: ${(file.size / 1024 / 1024).toFixed(1)} МіБ (макс 20)`);
  }
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error('не вдалося прочитати файл'));
    fr.readAsDataURL(file);
  });
  // Data URL is `data:<mime>;base64,<data>` — strip the prefix for the raw base64 payload.
  const data = url.slice(url.indexOf(',') + 1);
  const name = file instanceof File ? file.name : `pasted.${mimeType.split('/')[1] ?? 'png'}`;
  return { data, mimeType, url, name };
}
