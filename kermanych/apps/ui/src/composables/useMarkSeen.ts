import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Session } from '@kermanych/core';
import { useSeen } from 'stores/seen';

// The session a page has open is READ, as it stands, for the unread-result marks: the sidebar's
// ring and the Dock icon's number (stores/seen.ts). Re-marked whenever it moves while open, so a
// result that lands under the operator's eyes lights neither — but only while the window is
// actually visible: a result that arrives behind another app has not been seen, and is marked the
// moment the window comes back. Every page that opens a session uses it: «Агенти» and «Дизайн».
export function useMarkSeen(open: () => Session | undefined): void {
  const seen = useSeen();
  function mark(): void {
    const s = open();
    if (s && document.visibilityState === 'visible') seen.markSeen(s.id, s.lastActivityAt);
  }
  watch(() => [open()?.id, open()?.lastActivityAt], mark, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', mark));
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', mark));
}
