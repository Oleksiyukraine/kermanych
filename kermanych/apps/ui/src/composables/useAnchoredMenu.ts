// A popover pinned under a trigger, its right edge on the trigger's right edge — for controls at
// the right end of a header, where a menu hanging off the left corner would cover what is
// beside it (KSplitButton's rule). The popover is a `position: fixed` node teleported to <body>
// (lib/menu.ts says why); this owns opening, placing, following scroll/resize, and closing on
// a pointer outside both nodes or on Esc. Esc is claimed (preventDefault), so the window under
// the popover does not close with it.
import { nextTick, onBeforeUnmount, ref, type Ref } from 'vue';
import { isAnchorOffscreen, placeMenu } from '../lib/menu';

export function useAnchoredMenu(anchorEl: Ref<HTMLElement | null>, menuEl: Ref<HTMLElement | null>) {
  const open = ref(false);

  function place(): void {
    const r = anchorEl.value?.getBoundingClientRect();
    const m = menuEl.value;
    if (!r || !m) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (isAnchorOffscreen(r, viewport)) {
      close();
      return;
    }
    m.style.maxHeight = '';
    const box = { width: m.offsetWidth, height: m.offsetHeight };
    const at = placeMenu({ top: r.top, bottom: r.bottom, width: r.width, left: r.right - box.width }, box, viewport);
    m.style.left = `${at.left}px`;
    m.style.top = `${at.top}px`;
    m.style.maxHeight = `${at.maxHeight}px`;
  }

  function onPointerDown(e: PointerEvent): void {
    const target = e.target as Node;
    if (!anchorEl.value?.contains(target) && !menuEl.value?.contains(target)) close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close(true);
  }

  async function show(): Promise<void> {
    if (open.value) return;
    open.value = true;
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('resize', place);
    await nextTick();
    place();
    menuEl.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }

  function close(refocus = false): void {
    if (!open.value) return;
    open.value = false;
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    if (refocus) anchorEl.value?.focus();
  }

  function toggle(): void {
    if (open.value) close();
    else void show();
  }

  onBeforeUnmount(() => close());

  return { open, show, close, toggle };
}
