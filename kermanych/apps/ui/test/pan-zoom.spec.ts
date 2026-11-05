import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, clampView, zoomAt } from '../src/composables/usePanZoom';

describe('zoomAt', () => {
  it('keeps the point under the pointer where it was', () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // The content point that sat at (100, 50) is still there: x + 100 * scale.
    expect(v.x + 100 * v.scale).toBe(100);
  });

  it('stays within the scale limits', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.001, 0, 0).scale).toBe(MIN_SCALE);
    // An inline diagram never shrinks below fit.
    expect(zoomAt({ scale: 1.5, x: 0, y: 0 }, 0.1, 0, 0, 1).scale).toBe(1);
  });
});

describe('clampView', () => {
  const stage = { width: 400, height: 300 };

  it('lets a picture bigger than the stage move only up to its own edges', () => {
    const content = { width: 400, height: 1000 };
    expect(clampView({ scale: 1, x: 50, y: 20 }, content, stage)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 1, x: 0, y: -900 }, content, stage)).toEqual({ scale: 1, x: 0, y: -700 });
    expect(clampView({ scale: 2, x: -300, y: -100 }, content, stage)).toEqual({ scale: 2, x: -300, y: -100 });
  });

  it('keeps a picture smaller than the stage inside it', () => {
    const content = { width: 400, height: 200 };
    expect(clampView({ scale: 0.5, x: -10, y: 500 }, content, stage)).toEqual({ scale: 0.5, x: 0, y: 200 });
  });
});
