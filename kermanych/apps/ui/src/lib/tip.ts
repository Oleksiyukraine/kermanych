import type { Directive } from 'vue';

// `v-tip="text"` — the app's tooltip. Purely presentational: it paints a bubble
// and nothing else. Glyph-only controls still need their own `aria-label`, since
// this node is never referenced by the accessibility tree.
//
// Why a directive over a component wrapper: icon clusters are dense (up to five
// controls in a 34px panel header, more per table row), and a directive keeps a
// single shared bubble for the whole app instead of one hidden node per control.
//
// Why not a CSS `::after` on the control: `.agents__board` sets `overflow-y: auto`,
// which computes `overflow-x` to `auto` as well, so an absolutely positioned
// pseudo-element gets cropped by the scroll container. A `position: fixed` node
// under <body> is immune.
//
// Why not the native `title`: ~1s OS delay, unstyled, and it never appears on
// keyboard focus.

// Pointer dwell before the bubble shows. Keyboard focus is deliberate, so it
// skips the delay.
const HOVER_DELAY_MS = 120;
// Offset from the control's edge, and the minimum breathing room at the viewport
// border once the bubble is clamped. 8, not the bubble's old 6: the glass bubble
// casts a shadow now, and a cast that touches its trigger reads as a seam.
const GAP_PX = 8;

let bubble: HTMLElement | null = null;
let host: HTMLElement | null = null;
// Where the session browser's native view is painted (stores/browser.ts `shownRect`), null
// while it is parked. Electron draws that view above the whole DOM, so a bubble under it is
// invisible however high its z-index: place() keeps the bubble out of this rect.
let keepOut: TipRect | null = null;
// `window.setTimeout` (not the bare global) so the handle is a DOM `number`
// rather than picking up Node's `Timeout` from ambient types.
let timer: number | undefined;

function ensureBubble(): HTMLElement {
  if (bubble) return bubble;

  const el = document.createElement('div');
  el.className = 'k-tip';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  bubble = el;

  // Any layout shift under a visible bubble would leave it pointing at nothing;
  // cheaper and steadier to drop it than to re-measure. `scroll` needs capture
  // to catch inner scroll containers, which do not bubble their scroll events.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', onKeydown, true);

  return el;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hide();
}

export interface TipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function setTipKeepOut(rect: TipRect | null): void {
  keepOut = rect;
}

type Side = 'top' | 'bottom';
interface Spot {
  left: number;
  top: number;
  side: Side;
}

// Narrowest a bubble squeezed beside the view may get before squeezing is worse than the
// overlap: below this the text breaks every word or two.
const MIN_SQUEEZE_PX = 120;

// Right-aligned to the control: every tooltipped cluster in the app sits against
// a right edge (panel header, table actions column), so growing leftwards keeps
// the bubble on screen; `lo`/`hi` bound it horizontally. Below the control unless
// `side` says otherwise or the bottom would overflow.
function spot(r: DOMRect, w: number, h: number, lo: number, hi: number, side?: Side): Spot {
  const left = Math.min(Math.max(r.right - w, lo), Math.max(hi - w, lo));
  const s = side ?? (r.bottom + GAP_PX + h > window.innerHeight - GAP_PX ? 'top' : 'bottom');
  return { left, top: s === 'top' ? r.top - h - GAP_PX : r.bottom + GAP_PX, side: s };
}

function hits(p: Spot, w: number, h: number, k: TipRect): boolean {
  return p.left < k.x + k.width && p.left + w > k.x && p.top < k.y + k.height && p.top + h > k.y;
}

// Where the bubble would land under the session browser's view, it moves out of it: first to
// the control's other side (a toolbar button above the view gets its bubble above), then — for
// a control beside the view — onto the control's side of it, narrowed so its text wraps there.
function placeAround(r: DOMRect, tip: HTMLElement, k: TipRect, first: Spot): Spot {
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = window.innerWidth;
  const flipped = spot(r, w, h, GAP_PX, vw - GAP_PX, first.side === 'top' ? 'bottom' : 'top');
  const fits = flipped.top >= GAP_PX && flipped.top + h <= window.innerHeight - GAP_PX;
  if (fits && !hits(flipped, w, h, k)) return flipped;

  let lo = GAP_PX;
  let hi = vw - GAP_PX;
  if (r.right <= k.x) hi = k.x - GAP_PX;
  else if (r.left >= k.x + k.width) lo = k.x + k.width + GAP_PX;
  else return first;
  if (hi - lo < MIN_SQUEEZE_PX) return first;
  if (w > hi - lo) tip.style.maxWidth = `${hi - lo}px`;
  return spot(r, tip.offsetWidth, tip.offsetHeight, lo, hi);
}

function place(el: HTMLElement, tip: HTMLElement): void {
  // A squeeze from the previous show must not narrow this one.
  tip.style.maxWidth = '';
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let p = spot(r, w, h, GAP_PX, window.innerWidth - GAP_PX);
  if (keepOut && hits(p, w, h, keepOut)) p = placeAround(r, tip, keepOut, p);

  // The entrance slide has to travel TOWARDS the control, so the stylesheet
  // needs to know which way the bubble ended up facing (src/css/app.scss).
  tip.dataset.side = p.side;
  tip.style.left = `${Math.round(p.left)}px`;
  tip.style.top = `${Math.round(p.top)}px`;
}

// `v-tip.overflow`: the bubble repeats a label the layout cut short (a file name ending in
// «…»), so it shows only while that label is actually clipped — a name that fits needs no
// bubble. The clipped element is the one marked `data-tip-clip` inside the control, or the
// control itself. Judged at show time, so a resize between hovers is taken into account.
function clipped(el: HTMLElement): boolean {
  const target = el.querySelector<HTMLElement>('[data-tip-clip]') ?? el;
  return target.scrollWidth > target.clientWidth + 1;
}

function show(el: HTMLElement): void {
  const text = el.dataset.tip;
  if (!text) return;
  if (el.dataset.tipOverflow && !clipped(el)) return;

  const tip = ensureBubble();
  // A full-screen viewer is a popover in the top layer (useFullscreenPopover), which paints
  // over any z-index: a bubble under <body> would sit behind it. So the bubble goes into the
  // open popover holding the control, and back to <body> otherwise. Still `position: fixed`
  // against the window — none of those layers is a containing block.
  const layer = el.closest<HTMLElement>(':popover-open') ?? document.body;
  if (tip.parentElement !== layer) layer.appendChild(tip);
  host = el;
  tip.textContent = text;
  // Measured before it is shown: the resting style is `visibility: hidden`, not
  // `display: none`, so the box is already laid out here.
  place(el, tip);
  // Flush the resting frame — new position AND the `data-side` rest offset — before
  // the reveal. Without it, a bubble that flips sides between two shows would start
  // its slide from the previous side's offset and travel AWAY from its control.
  void tip.offsetHeight;
  tip.classList.add('k-tip--on');
}

function hide(): void {
  window.clearTimeout(timer);
  timer = undefined;
  host = null;
  bubble?.classList.remove('k-tip--on');
}

function onEnter(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => show(el), HOVER_DELAY_MS);
}

function onFocus(e: Event): void {
  window.clearTimeout(timer);
  show(e.currentTarget as HTMLElement);
}

// Also on click: the control's action often removes it or swaps its label
// (stop → run, finish → reopen), and a bubble outliving its trigger lies.
function onLeave(): void {
  hide();
}

const EVENTS: Array<[string, EventListener]> = [
  ['mouseenter', onEnter],
  ['mouseleave', onLeave],
  ['focusin', onFocus],
  ['focusout', onLeave],
  ['click', onLeave],
];

export const tip: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) {
    setText(el, binding.value);
    if (binding.modifiers.overflow) el.dataset.tipOverflow = '1';
    for (const [name, fn] of EVENTS) el.addEventListener(name, fn);
  },

  updated(el, binding) {
    setText(el, binding.value);
    if (host !== el) return;
    // Live retarget: a visible bubble whose text just changed must not keep the
    // stale copy, and losing the text means losing the bubble.
    if (binding.value && bubble) {
      bubble.textContent = binding.value;
      place(el, bubble);
    } else {
      hide();
    }
  },

  unmounted(el) {
    if (host === el) hide();
    for (const [name, fn] of EVENTS) el.removeEventListener(name, fn);
  },
};

function setText(el: HTMLElement, text: string | undefined): void {
  if (text) el.dataset.tip = text;
  else delete el.dataset.tip;
}

// Registered globally in src/boot/tip.ts; declaring it here lets vue-tsc check
// `v-tip` bindings in every template.
declare module 'vue' {
  interface GlobalDirectives {
    vTip: typeof tip;
  }
}
