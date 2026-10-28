// apps/ui/src/composables/useFullscreenPopover.ts
import { watch, type Ref } from 'vue';

// «Full screen» for a viewer without moving it. The element is a manual popover
// (`popover="manual"`), and full screen is showPopover(): the browser promotes that SAME node
// to the top layer — above every clip and stacking context of the app shell — without
// re-parenting it. A re-parented iframe reloads and a moved scroller loses its offset, and a
// second instance loses everything local to the viewer (mode, ±, folds); this keeps them all.
//
// Closed, the popover's UA styles (display:none, fixed, centred, bordered, Canvas colours) are
// the host stylesheet's to undo, so the element sits in the page flow; open, it styles
// `:popover-open` to cover the window. A full-screen viewer that should park the session
// browser's native view also sets role="dialog" while open (useOverlayOpen).
//
// A Quasar dialog (KModal, confirmAction) renders below the top layer: a host that opens one
// from inside the viewer leaves full screen first.
export function useFullscreenPopover(el: Ref<HTMLElement | null>, on: Ref<boolean>): void {
  watch(
    [on, el],
    ([full, node]) => {
      if (!node?.isConnected) return;
      const open = node.matches(':popover-open');
      if (full && !open) node.showPopover();
      else if (!full && open) node.hidePopover();
    },
    { flush: 'post', immediate: true },
  );
}
