import { onMounted, onUnmounted, ref, type Ref } from 'vue';

// Whether any floating layer of the app is on screen right now. The session browser's native
// view is painted by Electron above the whole DOM, so nothing the renderer draws can cover it;
// the pane parks the view while this reads true and shows a still frame of the page in its
// place (docs/specs/2026-10-05-embedded-browser.md).
//
// One structural signal instead of a list of dialogs: every floating layer here already
// declares an ARIA role — QDialog (KModal) renders `role="dialog"`, QMenu / KChipSelect / the
// Агенти ⋯ menu `role="menu"`, KSelect's list `role="listbox"`, KDateField's grid `role="dialog"`.
// An element counts only while rendered: a v-show-hidden picker in another tab (the Лог
// composer's emoji grid) has no client rects. Toasts do not count: KToast moves its stack
// beside the shown view (stores/browser.ts `shownRect`), so an error stays readable without
// parking the page. Neither do v-tip bubbles: parking the view for every hover would make it
// flicker.
const OVERLAY = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

export function overlayOnScreen(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll(OVERLAY)) if (el.getClientRects().length > 0) return true;
  return false;
}

// Re-evaluated on DOM changes (coalesced to one check per frame — the Лог pane streams
// mutations while a turn runs) for as long as the calling component is mounted.
export function useOverlayOpen(): Ref<boolean> {
  const open = ref(false);
  let frame = 0;
  const check = (): void => {
    frame = 0;
    open.value = overlayOnScreen();
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  const observer = new MutationObserver(schedule);
  onMounted(() => {
    // `style`/`class` too: Quasar and v-show toggle visibility without adding nodes.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'role'] });
    check();
  });
  onUnmounted(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  });
  return open;
}
