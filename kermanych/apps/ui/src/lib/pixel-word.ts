// The word КЕРМАНИЧ drawn as pixels that gather from a scatter — the sign-in loader
// (components/auth/AuthLoader.vue). The glyphs and the seeded scatter are the landing page's coda
// (kermanych-landing, assets/site.js `initHelm`), so the app and the site draw the same picture.

/** 5×7 glyphs, one string per row; `1` is a lit pixel. Only the letters of КЕРМАНИЧ. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  К: ['1...1', '1..1.', '1.1..', '11...', '1.1..', '1..1.', '1...1'],
  Е: ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
  Р: ['1111.', '1...1', '1...1', '1111.', '1....', '1....', '1....'],
  М: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
  А: ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  Н: ['1...1', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  И: ['1...1', '1...1', '1..11', '1.1.1', '11..1', '1...1', '1...1'],
  Ч: ['1...1', '1...1', '1...1', '.1111', '....1', '....1', '....1'],
};

export const PIXEL_CELL = 10;
const GLYPH_ROWS = 7;
const NOISE = 70;
const ACCENT_SHARE = 0.14;

export interface Pixel {
  /** Top-left corner in viewBox units. */
  x: number;
  y: number;
  /** `letter` lands in the word; `noise` belongs to no letter and only fades. */
  kind: 'letter' | 'accent' | 'noise';
  /** The scatter the pixel flies in from: offset in viewBox units, turn in degrees. */
  dx: number;
  dy: number;
  r: number;
}

export interface PixelWord {
  width: number;
  height: number;
  pixels: Pixel[];
}

/**
 * Lays out `word` (uppercase Cyrillic from GLYPHS; other characters leave a blank cell) with a
 * scatter seeded by `seed` (a Park–Miller generator), so every draw is the same picture.
 */
export function pixelWord(word: string, seed = 20261115): PixelWord {
  const letters = [...word];
  const cols = letters.length * 6 - 1;
  let s = seed;
  const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647;
  const pixels: Pixel[] = [];
  const add = (cx: number, cy: number, kind: Pixel['kind']): void => {
    pixels.push({
      x: cx * PIXEL_CELL,
      y: cy * PIXEL_CELL,
      kind,
      dx: Math.round((rnd() - 0.5) * cols * PIXEL_CELL * 0.7),
      dy: Math.round((rnd() - 0.5) * GLYPH_ROWS * PIXEL_CELL * 3),
      r: Math.round((rnd() - 0.5) * 240),
    });
  };
  letters.forEach((ch, i) => {
    (GLYPHS[ch] ?? []).forEach((row, y) => {
      [...row].forEach((bit, x) => {
        if (bit === '1') add(i * 6 + x, y, rnd() < ACCENT_SHARE ? 'accent' : 'letter');
      });
    });
  });
  for (let n = 0; n < NOISE; n++) add(Math.floor(rnd() * cols), Math.floor(rnd() * GLYPH_ROWS), 'noise');
  return { width: cols * PIXEL_CELL, height: GLYPH_ROWS * PIXEL_CELL, pixels };
}
