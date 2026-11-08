// @vitest-environment happy-dom
// v-tip's bubble against the session browser's view: Electron paints that view above the whole
// DOM, so a bubble placed under it is invisible (the Синергія card's spend tooltip was).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DirectiveBinding, ObjectDirective } from 'vue';
import { setTipKeepOut, tip } from '../src/lib/tip';

// happy-dom lays nothing out: the bubble is NATURAL_W wide unless its inline max-width is
// narrower, and wraps to more lines as it narrows.
const NATURAL_W = 280;
const LINE_H = 15;
const VIEW = { x: 200, y: 100, width: 1000, height: 700 };

beforeAll(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const width = (el: HTMLElement): number => {
    const max = parseFloat(el.style.maxWidth);
    return Number.isNaN(max) ? NATURAL_W : Math.min(max, NATURAL_W);
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('k-tip') ? width(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('k-tip') ? Math.ceil(NATURAL_W / width(this)) * LINE_H + 12 : 0;
    },
  });
});

afterEach(() => {
  setTipKeepOut(null);
  document.body.innerHTML = '';
});

function control(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.createElement('span');
  el.getBoundingClientRect = () => new DOMRect(rect.left, rect.top, rect.width, rect.height);
  document.body.appendChild(el);
  const directive = tip as ObjectDirective<HTMLElement, string | undefined>;
  directive.mounted!(el, { value: 'MegaSuperModel · 1.2M ток · $3.40', modifiers: {} } as DirectiveBinding<string>, null!, null);
  return el;
}

function hover(el: HTMLElement): { left: number; top: number; width: number; height: number; side: string | undefined } {
  el.dispatchEvent(new FocusEvent('focusin'));
  const b = document.querySelector<HTMLElement>('.k-tip')!;
  el.dispatchEvent(new FocusEvent('focusout'));
  return { left: parseFloat(b.style.left), top: parseFloat(b.style.top), width: b.offsetWidth, height: b.offsetHeight, side: b.dataset.side };
}

describe('v-tip around the session browser view', () => {
  it('keeps the bubble of a control left of the view on its side, narrowed to fit', () => {
    setTipKeepOut(VIEW);
    // A narrow card list beside the view: right-aligned, the bubble would hit the window's left
    // edge and run on under the view.
    const b = hover(control({ left: 160, top: 300, width: 16, height: 16 }));
    expect(b.left).toBeGreaterThanOrEqual(8);
    expect(b.left + b.width).toBeLessThanOrEqual(VIEW.x);
    expect(b.side).toBe('bottom');
  });

  it('flips the bubble of a control just above the view to above the control', () => {
    setTipKeepOut(VIEW);
    const b = hover(control({ left: 600, top: 60, width: 30, height: 30 }));
    expect(b.side).toBe('top');
    expect(b.top + b.height).toBeLessThanOrEqual(60);
  });

  it('places as before once the view is parked, without the earlier squeeze', () => {
    const el = control({ left: 160, top: 300, width: 16, height: 16 });
    setTipKeepOut(VIEW);
    hover(el);
    setTipKeepOut(null);
    const b = hover(el);
    expect(b.width).toBe(NATURAL_W);
    expect(b.left).toBe(8);
    expect(b.top).toBe(324);
  });
});
