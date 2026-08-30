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

// Right-aligned to the control: every tooltipped cluster in the app sits against
// a right edge (panel header, table actions column), so growing leftwards keeps
// the bubble on screen. Flips above the control when the bottom would overflow.
function place(el: HTMLElement, tip: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;

  const maxLeft = window.innerWidth - w - GAP_PX;
  const left = Math.min(Math.max(r.right - w, GAP_PX), Math.max(maxLeft, GAP_PX));

  const below = r.bottom + GAP_PX;
  const flip = below + h > window.innerHeight - GAP_PX;
  const top = flip ? r.top - h - GAP_PX : below;

  // The entrance slide has to travel TOWARDS the control, so the stylesheet
  // needs to know which way the bubble ended up facing (src/css/app.scss).
  tip.dataset.side = flip ? 'top' : 'bottom';
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show(el: HTMLElement): void {
  const text = el.dataset.tip;
  if (!text) return;

  const tip = ensureBubble();
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
