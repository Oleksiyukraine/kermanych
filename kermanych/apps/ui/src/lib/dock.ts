// apps/ui/src/lib/dock.ts
// The Dock icon (docs/specs/2026-11-01-dock-attention.md): its two switches in «Налаштування →
// Сповіщення» and its bounce. Device-local screen preferences like the theme — localStorage, on by
// default, applied at once. The number itself is pushed by the signed-in shell (MainLayout.vue).
import type { Ref } from 'vue';
import { persisted } from './persisted';

/** «Число на іконці»: the Dock icon shows how many agents wait for the operator. */
export const dockBadgeOn: Ref<boolean> = persisted('kermanych.dock.badge', true, (raw) => raw !== '0', (on) => (on ? '1' : '0'));

/** «Підстрибувати»: the Dock icon bounces once when another agent's turn passes to the operator. */
export const dockBounceOn: Ref<boolean> = persisted('kermanych.dock.bounce', true, (raw) => raw !== '0', (on) => (on ? '1' : '0'));

// One bounce when something new needs the operator. macOS bounces only while Kermanych is not the
// active app, so callers need no focus check. Nothing in the web build or with «Підстрибувати» off.
export function bounceDock(): void {
  if (dockBounceOn.value && typeof window !== 'undefined') window.kermanych?.dock?.bounce();
}
