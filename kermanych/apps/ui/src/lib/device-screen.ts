// The geometry and pixels of the device screen in the «Пристрій» tab
// (docs/specs/2026-11-03-mobile-device-preview.md, decisions 9, 12). The screen is drawn
// letterboxed into a canvas that fills the pane, and every point the operator gives (a touch, a
// wheel step, a pick) goes to the api as fractions 0..1 of the device screen — so mapping a
// pointer through the letterbox is the one place a tap could land beside its target. Pure: no
// DOM, pinned by a spec.

export type ScreenRect = { x: number; y: number; width: number; height: number };

// The largest rect of the frame's aspect ratio that fits the box, centred (object-fit: contain).
// Both in the same unit (canvas pixels for drawing, CSS pixels for the pointer). An empty frame
// or box gives an empty rect, which maps no point.
export function fitRect(frame: { width: number; height: number }, box: { width: number; height: number }): ScreenRect {
  if (frame.width <= 0 || frame.height <= 0 || box.width <= 0 || box.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

// A point in the box (relative to its top-left corner) → fractions of the drawn screen. Outside
// the screen (on the letterbox bars) it is null, unless `clamp`: a drag that started on the
// screen and left it keeps moving along its edge rather than being cut off.
export function screenPoint(px: number, py: number, rect: ScreenRect, clamp = false): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (px - rect.x) / rect.width;
  const y = (py - rect.y) / rect.height;
  if (clamp) return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

// One Android frame (RGB888, packed) into an RGBA buffer the caller keeps between frames, so a
// stream at ~30 fps does not allocate a new ImageData per frame. `src` may be longer than
// `pixels * 3` (a padded buffer); only `pixels` are copied.
export function rgbToRgba(src: Uint8Array, dst: Uint8ClampedArray, pixels: number): void {
  for (let i = 0, j = 0; i < pixels; i += 1, j += 3) {
    const o = i * 4;
    dst[o] = src[j]!;
    dst[o + 1] = src[j + 1]!;
    dst[o + 2] = src[j + 2]!;
    dst[o + 3] = 255;
  }
}

// A wheel event's delta in CSS pixels: line and page modes (Firefox, some mice) scaled the way
// browsers scroll them.
export function wheelPixels(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * page;
  return delta;
}
