// Photos from the phone's camera (decision 3: «sending a message (photos from the camera
// included)»). A phone photo is 4–12 MB; the agent needs far less, and the message travels
// through the tailnet as JSON, so each photo is cut down to fit `MAX_SIDE` and re-encoded as JPEG.

/** The longer side of a sent photo, in pixels. */
export const MAX_SIDE = 1600;
export const JPEG_QUALITY = 0.85;
/** Photos in one message. */
export const MAX_IMAGES = 4;

/** The size a `width × height` image is drawn at: never upscaled, aspect kept, whole pixels. */
export function fitSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** `data:<mime>;base64,<data>` → `<data>`: the api takes bare base64 (RemoteMessageRequest). */
export function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
}

export type PreparedImage = {
  /** Bare base64 of the JPEG. */
  data: string;
  mimeType: "image/jpeg";
  /** The full data URL, for the composer's thumbnail. */
  preview: string;
};

// `decode()` rather than onload: one promise, and it resolves only once the pixels are ready to
// draw (Safari ≥ 11.1, so every iOS that has Web Push).
async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Decode, downscale and re-encode one picked file. An `<img>` applies the photo's EXIF rotation
 * itself (`image-orientation: from-image` is the default everywhere the phone runs), so the
 * canvas gets the picture the right way up.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const size = fitSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const preview = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return { data: stripDataUrl(preview), mimeType: "image/jpeg", preview };
  } finally {
    URL.revokeObjectURL(url);
  }
}
