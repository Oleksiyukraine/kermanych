// apps/ui/src/stores/assistant-overlay.ts
// The Менеджмент assistant called up from anywhere (docs/specs/2026-11-03-assistant-overlay.md):
// whether the overlay is open, whether an answer landed while nobody was looking, and the one
// «summon» signal that ⌘K, the circle gesture, the mascot and the session browser all send.
//
// A summons is a counter rather than a call into a component because two views answer it and
// only one is mounted at a time: on the Менеджмент tab the page's own dock takes focus (decision
// 7), everywhere else the shell's launcher toggles the overlay. Each watches `summons` and acts
// only where it lives, so no caller has to know which tab is on screen.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Ref } from 'vue';
import { persisted } from '../lib/persisted';

/** «Жест для виклику асистента»: a counter-clockwise mouse circle summons the assistant. */
export const assistantGestureOn: Ref<boolean> = persisted(
  'kermanych.assistant.gesture',
  true,
  (raw) => raw !== '0',
  (on) => (on ? '1' : '0'),
);

/**
 * «Персонаж асистента»: which character peeks out of the window's left edge
 * (docs/specs/2026-11-03-assistant-mascot-choice.md). In the order the picker shows them; the
 * first is the default, and a stored id no longer in the list reads as it.
 */
export const ASSISTANT_MASCOTS = ['bot-eyes', 'bot', 'drop', 'tile', 'eyes', 'captain', 'spark'] as const;
export type AssistantMascotId = (typeof ASSISTANT_MASCOTS)[number];

export const assistantMascot: Ref<AssistantMascotId> = persisted<AssistantMascotId>(
  'kermanych.assistant.mascot',
  ASSISTANT_MASCOTS[0],
  (raw) => ASSISTANT_MASCOTS.find((id) => id === raw) ?? null,
  (id) => id,
);

export const useAssistantOverlay = defineStore('assistant-overlay', () => {
  const open = ref(false);
  // An answer finished while the overlay was closed: the mascot wears a dot until it is opened.
  const unread = ref(false);
  const summons = ref(0);

  function show(): void {
    open.value = true;
    unread.value = false;
  }

  function close(): void {
    open.value = false;
  }

  function summon(): void {
    summons.value++;
  }

  return { open, unread, summons, show, close, summon };
});
