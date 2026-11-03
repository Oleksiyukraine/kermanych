// apps/ui/src/composables/usePanZoom.ts

// A picture you can pinch and push around, as in an image viewer. The picture sits at its
// stage's top-left, laid out to fit (scale 1), and moves by a CSS transform:
//
//   * trackpad pinch (Chromium reports it as a wheel event with ctrlKey) or ⌘/Ctrl + wheel
//     zooms around the pointer;
//   * a two-finger swipe (a plain wheel) moves the picture, and so does a drag with the mouse
//     or one finger; two fingers on a touch screen pinch and move at once;
//   * a double click goes back to fit.
//
// Moving is clamped like a scroll area: a picture bigger than the stage cannot be pulled
// past its own edge, a smaller one stays inside the stage.
//
// Two kinds of stage. A `free` one is the picture's own pane (an opened image file): every
// gesture is the picture's. An `inline` one is a diagram inside a rendered doc, clipped to
// its own box: it never shrinks below fit, and a swipe or a mouse drag is the doc's until the
// diagram is zoomed in — and again once the diagram has reached its edge — so reading the doc
// is never trapped in a picture.

export type View = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };
export type StageKind = 'free' | 'inline';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 20;

// One axis: the content (`size`, scaled) at offset `pos` inside a stage of `stage`.
function clampAxis(pos: number, size: number, stage: number): number {
  const lo = Math.min(0, stage - size);
  const hi = Math.max(0, stage - size);
  return Math.min(Math.max(pos, lo), hi);
}

export function clampView(v: View, content: Size, stage: Size): View {
  return {
    scale: v.scale,
    x: clampAxis(v.x, content.width * v.scale, stage.width),
    y: clampAxis(v.y, content.height * v.scale, stage.height),
  };
}

// Zoom by `factor` keeping the stage point (px, py) over the same spot of the content.
export function zoomAt(v: View, factor: number, px: number, py: number, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = Math.min(Math.max(v.scale * factor, min), max);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export interface PanZoom {
  reset(): void;
  onWheel(e: WheelEvent): void;
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  onPointerUp(e: PointerEvent): void;
}

// `stage` clips, `content` (its first <img>) moves. The state shows on the stage as
// data-panzoom="zoomed" / "dragging", for the stylesheet's cursors.
export function createPanZoom(stage: HTMLElement, content: HTMLElement, kind: StageKind): PanZoom {
  const min = kind === 'inline' ? 1 : MIN_SCALE;
  let view: View = { scale: 1, x: 0, y: 0 };
  // Active pointers by id: one drags, two pinch (their midpoint moves, their spread zooms).
  const pointers = new Map<number, { x: number; y: number }>();

  function paint(): void {
    content.style.transform = view.scale === 1 && !view.x && !view.y
      ? ''
      : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    stage.dataset.panzoom = pointers.size ? 'dragging' : view.scale > 1 ? 'zoomed' : '';
  }

  // Clamped against the live sizes; whether anything moved, so an inline stage can hand a
  // swipe that went nowhere back to the doc.
  function set(v: View): boolean {
    // offsetWidth/Height ignore the transform: the content's own laid-out (scale 1) size.
    const next = clampView(
      v,
      { width: content.offsetWidth, height: content.offsetHeight },
      { width: stage.clientWidth, height: stage.clientHeight },
    );
    const moved = next.scale !== view.scale || next.x !== view.x || next.y !== view.y;
    view = next;
    paint();
    return moved;
  }

  function local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function spread(): { mid: { x: number; y: number }; dist: number } | null {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return null;
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  return {
    reset(): void {
      pointers.clear();
      view = { scale: 1, x: 0, y: 0 };
      paint();
    },

    onWheel(e: WheelEvent): void {
      // A line-mode wheel (a mouse notch) reports lines, not pixels.
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // Always claimed: unclaimed, a pinch would zoom the whole window.
        e.preventDefault();
        const p = local(e);
        set(zoomAt(view, Math.exp(-e.deltaY * unit * 0.01), p.x, p.y, min));
        return;
      }
      if (kind === 'inline' && view.scale <= 1) return;
      if (set({ ...view, x: view.x - e.deltaX * unit, y: view.y - e.deltaY * unit }) || kind === 'free') {
        e.preventDefault();
      }
    },

    onPointerDown(e: PointerEvent): void {
      if (e.pointerType === 'mouse' && (e.button !== 0 || (kind === 'inline' && view.scale <= 1))) return;
      if (e.pointerType === 'mouse') e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      paint();
    },

    onPointerMove(e: PointerEvent): void {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const before = spread();
      const p = local(e);
      pointers.set(e.pointerId, p);
      const after = spread();
      if (before && after) {
        const zoomed = before.dist > 0 ? zoomAt(view, after.dist / before.dist, after.mid.x, after.mid.y, min) : view;
        set({ ...zoomed, x: zoomed.x + after.mid.x - before.mid.x, y: zoomed.y + after.mid.y - before.mid.y });
      } else if (pointers.size === 1) {
        set({ ...view, x: view.x + p.x - prev.x, y: view.y + p.y - prev.y });
      }
    },

    onPointerUp(e: PointerEvent): void {
      pointers.delete(e.pointerId);
      paint();
    },
  };
}

// Every stage under one root, by delegation — a rendered doc's diagrams come from v-html and
// have no template to bind to. A stage is any element with data-pz-stage="free|inline"
// holding an <img>; its controller is made on first touch and dies with the element.
export function usePanZoom() {
  const controllers = new WeakMap<HTMLElement, PanZoom>();

  function controllerFor(target: EventTarget | null): PanZoom | null {
    const stage = target instanceof Element ? target.closest<HTMLElement>('[data-pz-stage]') : null;
    if (!stage) return null;
    let pz = controllers.get(stage);
    if (!pz) {
      const img = stage.querySelector('img');
      if (!img) return null;
      pz = createPanZoom(stage, img, stage.dataset.pzStage === 'inline' ? 'inline' : 'free');
      controllers.set(stage, pz);
    }
    return pz;
  }

  return {
    // Back to fit for the stage element given (a reused pane showing a new picture).
    reset(stage: HTMLElement | null): void {
      if (stage) controllers.get(stage)?.reset();
    },
    listeners: {
      wheel: (e: WheelEvent) => controllerFor(e.target)?.onWheel(e),
      pointerdown: (e: PointerEvent) => controllerFor(e.target)?.onPointerDown(e),
      pointermove: (e: PointerEvent) => controllerFor(e.target)?.onPointerMove(e),
      pointerup: (e: PointerEvent) => controllerFor(e.target)?.onPointerUp(e),
      pointercancel: (e: PointerEvent) => controllerFor(e.target)?.onPointerUp(e),
      dblclick: (e: MouseEvent) => controllerFor(e.target)?.reset(),
    },
  };
}
