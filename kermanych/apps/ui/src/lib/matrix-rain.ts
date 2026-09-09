// The Matrix theme's entry reveal: the film's "digital rain". Where the
// light/dark switch grows a clip-path circle over two frozen snapshots
// (lib/reveal.ts), stepping INTO the Matrix earns its own effect — a
// full-viewport canvas of falling glyphs that thickens to opaque black, hides
// the palette swap happening underneath, then dissolves to show the green-on-
// black shell. The theme it swaps to is itself green on black, so the fade-out
// lands on the rain's own colours with nothing to jar the eye.
//
// Hand-rolled rather than pulled from a dependency: the effect is a few dozen
// lines of canvas, it runs once per switch, and a library would drag in its own
// lifecycle just to draw a grid of characters. The whole thing lives behind one
// exported function with the same reduced-motion / no-DOM fallback the circle
// wipe uses, so a caller cannot tell the two reveals apart at the call site.

// Half-width katakana (the film's alphabet) plus digits and a few Latin marks.
// Sampled uniformly per cell, so the column reads as noise, not text.
const GLYPHS =
  'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:."=*+-<>¦｜╌';

// The rain runs opaque long enough to register as itself, then dissolves. Both
// are deliberately longer than the 480ms circle wipe: this reveal is the point,
// not a courtesy transition, and the swap is masked so nothing is felt as lag.
const RAIN_MS = 900;
const FADE_MS = 600;
// Swap the palette while the canvas is at its densest — past this fraction of
// the opaque phase the accumulated black wash fully hides the DOM beneath.
const SWAP_AT = 0.45;
// Cell size in CSS px. Also the glyph size; the grid is one glyph per cell.
const CELL = 16;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Run `swap` — the state mutation that repaints the app into the Matrix theme —
 * under a digital-rain canvas that masks the change.
 *
 * Instant fallbacks, matching lib/reveal.ts: no document (SSR / vitest node),
 * no 2D context, or an operator who asked for less motion. In every fallback
 * `swap` still runs exactly once, synchronously, so the theme always changes.
 */
export function matrixReveal(swap: () => void): void {
  if (typeof document === 'undefined' || prefersReducedMotion()) {
    swap();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const s = canvas.style;
  s.position = 'fixed';
  s.inset = '0';
  s.width = '100%';
  s.height = '100%';
  s.zIndex = '99999';
  s.pointerEvents = 'none';
  s.background = 'transparent';

  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) {
    swap();
    return;
  }
  // Non-null alias so the render closures below inherit a non-null type rather
  // than re-checking the guard TypeScript will not carry across a closure.
  const ctx = maybeCtx;
  document.body.appendChild(canvas);

  // Cap the backing store at 2x: past that the rain costs fill-rate for pixels
  // no one reads while it flickers past.
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  let w = 0;
  let h = 0;
  let cols = 0;
  // Per-column head position, in cells. Seeded above the fold so the rain is
  // already falling on the first frame rather than starting from a clean top.
  let drops: number[] = [];

  function resize(): void {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${CELL}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    cols = Math.ceil(w / CELL);
    drops = Array.from({ length: cols }, () => Math.floor((Math.random() * -h) / CELL));
  }
  resize();
  window.addEventListener('resize', resize);

  const rnd = (): string => GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);

  const start = performance.now();
  let swapped = false;
  let raf = 0;

  function cleanup(): void {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    canvas.remove();
    // Guard against an early teardown (hidden tab pausing rAF, say) that never
    // reached the swap point: the theme must change even if the effect is lost.
    if (!swapped) {
      swapped = true;
      swap();
    }
  }

  function frame(now: number): void {
    const t = now - start;

    // Translucent black wash each frame: builds the trailing tails and, over the
    // first frames, thickens the transparent canvas to opaque so the swap hides.
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < cols; i++) {
      const x = i * CELL;
      let d = drops[i] ?? 0;
      const y = d * CELL;
      // Bright head, dimmer trailing glyph one cell up — the classic two-tone
      // column. Both cells redraw a fresh glyph so the stream keeps churning.
      ctx.fillStyle = '#c8ffd0';
      ctx.fillText(rnd(), x, y);
      ctx.fillStyle = '#3fb46a';
      ctx.fillText(rnd(), x, y - CELL);
      // Recycle a column to the top once it clears the fold, at random, so the
      // heads never line up into a visible seam.
      if (y > h && Math.random() > 0.975) d = 0;
      drops[i] = d + 1;
    }

    if (!swapped && t >= RAIN_MS * SWAP_AT) {
      swapped = true;
      swap();
    }

    if (t < RAIN_MS) {
      raf = requestAnimationFrame(frame);
      return;
    }

    const k = (t - RAIN_MS) / FADE_MS;
    canvas.style.opacity = String(Math.max(0, 1 - k));
    if (k < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      cleanup();
    }
  }

  raf = requestAnimationFrame(frame);
}
