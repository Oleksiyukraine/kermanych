import { describe, expect, it } from 'vitest';
import { fitRect, rgbToRgba, screenPoint, wheelPixels } from '../src/lib/device-screen';

describe('fitRect', () => {
  it('letterboxes a portrait phone in a wide pane: full height, centred horizontally', () => {
    expect(fitRect({ width: 393, height: 852 }, { width: 1000, height: 852 })).toEqual({ x: 303.5, y: 0, width: 393, height: 852 });
  });

  it('pillarboxes a landscape screen in a tall pane: full width, centred vertically', () => {
    expect(fitRect({ width: 2000, height: 1000 }, { width: 400, height: 600 })).toEqual({ x: 0, y: 200, width: 400, height: 200 });
  });

  it('scales up a frame smaller than the pane (an Android frame sent at a lower size)', () => {
    expect(fitRect({ width: 100, height: 200 }, { width: 300, height: 300 })).toEqual({ x: 75, y: 0, width: 150, height: 300 });
  });

  it('gives an empty rect for an empty frame or box, never NaN', () => {
    expect(fitRect({ width: 0, height: 0 }, { width: 300, height: 300 })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(fitRect({ width: 393, height: 852 }, { width: 0, height: 500 })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('screenPoint', () => {
  // A 393×852 screen drawn at full height in a 1000×852 box: x from 303.5 to 696.5.
  const rect = fitRect({ width: 393, height: 852 }, { width: 1000, height: 852 });

  it('maps a point on the screen to fractions of the screen, not of the box', () => {
    expect(screenPoint(303.5, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(screenPoint(500, 426, rect)).toEqual({ x: (500 - 303.5) / 393, y: 0.5 });
    expect(screenPoint(696.5, 852, rect)).toEqual({ x: 1, y: 1 });
  });

  it('ignores a point on the letterbox bars', () => {
    expect(screenPoint(303, 400, rect)).toBeNull();
    expect(screenPoint(697, 400, rect)).toBeNull();
    expect(screenPoint(500, 853, rect)).toBeNull();
    expect(screenPoint(500, -1, rect)).toBeNull();
  });

  it('clamps to the screen edge for a drag that left it', () => {
    expect(screenPoint(50, 900, rect, true)).toEqual({ x: 0, y: 1 });
    expect(screenPoint(990, -40, rect, true)).toEqual({ x: 1, y: 0 });
  });

  it('maps nothing before the screen has a size', () => {
    expect(screenPoint(10, 10, { x: 0, y: 0, width: 0, height: 0 }, true)).toBeNull();
  });
});

describe('rgbToRgba', () => {
  it('expands packed RGB into an opaque RGBA buffer, in place', () => {
    const dst = new Uint8ClampedArray(8).fill(7);
    rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), dst, 2);
    expect([...dst]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('copies only the pixels asked for from a longer (padded) source', () => {
    const dst = new Uint8ClampedArray(4);
    rgbToRgba(new Uint8Array([9, 8, 7, 1, 1, 1]), dst, 1);
    expect([...dst]).toEqual([9, 8, 7, 255]);
  });
});

describe('wheelPixels', () => {
  it('keeps pixel deltas and scales line and page deltas', () => {
    expect(wheelPixels(40, 0, 800)).toBe(40);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(-1, 2, 800)).toBe(-800);
  });
});
