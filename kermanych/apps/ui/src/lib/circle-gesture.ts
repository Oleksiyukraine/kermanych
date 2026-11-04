// apps/ui/src/lib/circle-gesture.ts
// The assistant's mouse gesture (docs/specs/2026-11-03-assistant-overlay.md, decision 3): one
// counter-clockwise circle drawn with the pointer, no button held. Pure — fed pointer samples,
// answers whether the newest one completes a circle — so its thresholds are testable without a
// DOM; composables/useCircleGesture.ts is the window listener around it.
//
// The samples are judged around their own centroid: a circle is a path whose distance from its
// centre stays roughly constant while its angle around that centre sweeps a full turn. Each
// condition below rejects one everyday motion that is not a circle:
//   - a button held: a drag, a text selection, a resize, a canvas pan — reset outright;
//   - a pause (`gapMs`): two unrelated movements are not one stroke;
//   - the radius band: a twitch of the hand, or a sweep across the whole screen;
//   - `roundness` (nearest point vs the mean radius): a left-right shake runs THROUGH its own
//     centre, and so does a zig-zag — both sweep half-turns that would otherwise add up;
//   - `maxStep`: an angle jump between two samples is a line crossing the centre, not an arc;
//   - `windowMs`: a circle is one quick motion, not a slow wander that eventually closes.
// Screen y grows downward, so a visually counter-clockwise path DECREASES atan2's angle.

export type GesturePoint = { x: number; y: number; t: number };

export const CIRCLE_GESTURE = {
  windowMs: 1200,
  gapMs: 250,
  minRadius: 40,
  maxRadius: 300,
  roundness: 0.35,
  maxStep: 1.2,
  minPoints: 8,
} as const;

const TURN = Math.PI * 2;

export type CircleRecognizer = {
  // One pointer sample with the buttons it was made with (MouseEvent.buttons). True when it
  // completes a counter-clockwise circle; the stroke then starts over.
  move(p: GesturePoint, buttons: number): boolean;
  reset(): void;
};

export function createCircleRecognizer(opts: Partial<typeof CIRCLE_GESTURE> = {}): CircleRecognizer {
  const o = { ...CIRCLE_GESTURE, ...opts };
  let pts: GesturePoint[] = [];

  function reset(): void {
    pts = [];
  }

  function closesCircle(): boolean {
    if (pts.length < o.minPoints) return false;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let sum = 0;
    let nearest = Infinity;
    for (const p of pts) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      sum += d;
      if (d < nearest) nearest = d;
    }
    const radius = sum / pts.length;
    if (radius < o.minRadius || radius > o.maxRadius || nearest < radius * o.roundness) return false;
    let swept = 0;
    let prev = Math.atan2(pts[0]!.y - cy, pts[0]!.x - cx);
    for (let i = 1; i < pts.length; i++) {
      const a = Math.atan2(pts[i]!.y - cy, pts[i]!.x - cx);
      let d = a - prev;
      if (d > Math.PI) d -= TURN;
      else if (d < -Math.PI) d += TURN;
      if (Math.abs(d) > o.maxStep) return false;
      swept += d;
      prev = a;
    }
    return -swept >= TURN;
  }

  function move(p: GesturePoint, buttons: number): boolean {
    if (buttons !== 0) {
      reset();
      return false;
    }
    const last = pts[pts.length - 1];
    if (last && p.t - last.t > o.gapMs) reset();
    // Sub-pixel jitter adds samples without adding shape.
    else if (last && Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 2) return false;
    pts.push(p);
    const from = p.t - o.windowMs;
    let drop = 0;
    while (drop < pts.length && pts[drop]!.t < from) drop++;
    if (drop) pts = pts.slice(drop);
    if (!closesCircle()) return false;
    reset();
    return true;
  }

  return { move, reset };
}
