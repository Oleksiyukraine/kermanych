// apps/ui/src/lib/files.ts
// Client-side loading for the management chat's mixed attachments: the images omp takes
// natively plus the document types a manager actually mails around (PDF, Excel, Word,
// Pages). Failure messages are coded like lib/images.ts — they resolve through the global
// i18n adapter (`errors.file.*`), so the composer's error line shows them in the active
// locale.
import { globalTr } from '../boot/i18n';
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from './images';

// Keyed by extension because the extension is the honest signal here: macOS reports an
// empty `File.type` for a .pages bundle and browsers disagree on the .xls family, while
// the operator's file name states exactly what they attached.
const DOC_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pages: 'application/vnd.apple.pages',
};

// What the file-pick dialog offers: every supported image mime plus the document
// extensions above.
export const ATTACH_ACCEPT = [...SUPPORTED_IMAGE_TYPES, ...Object.keys(DOC_TYPES).map((e) => `.${e}`)].join(',');

// One cap for every kind: omp holds images to 20 MiB, and a document the model reads from
// disk deserves no bigger budget over a JSON body.
export const MAX_FILE_BYTES = MAX_IMAGE_BYTES;

// A pending attachment: `data`+`mimeType` feed the ask (raw base64), `name` labels it in
// the strip, the transcript and the model's «долучені файли» list, `url` (data URL) exists
// for images only and renders the thumbnail.
export type AttachedFile = { name: string; mimeType: string; data: string; url?: string };

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// The mime the attachment travels under, or undefined for a file this chat does not take.
// The browser's own `type` wins for images; documents resolve by extension (see DOC_TYPES).
function resolveType(file: File): string | undefined {
  if (SUPPORTED_IMAGE_TYPES.includes(file.type)) return file.type;
  return DOC_TYPES[extOf(file.name)];
}

// Read a picked/pasted/dropped File into an AttachedFile; throws a localized error on an
// unsupported type or oversize.
export async function fileToAttachment(file: File): Promise<AttachedFile> {
  const mimeType = resolveType(file);
  if (mimeType === undefined) {
    throw new Error(globalTr.t('errors.file.unsupported', { name: file.name }));
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      globalTr.t('errors.file.tooLarge', { name: file.name, size: (file.size / 1024 / 1024).toFixed(1) }),
    );
  }
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error(globalTr.t('errors.image.readFailed')));
    fr.readAsDataURL(file);
  });
  // Data URL is `data:<mime>;base64,<data>` — strip the prefix for the raw base64 payload.
  const data = url.slice(url.indexOf(',') + 1);
  const name = file.name || `pasted.${mimeType.split('/')[1] ?? 'png'}`;
  return {
    name,
    mimeType,
    data,
    ...(mimeType.startsWith('image/') ? { url } : {}),
  };
}
