// apps/ui/src/stores/assistant-overlay.ts
// The avatar's window (docs/specs/2026-11-04-cuk-control-console.md): whether it is open,
// which panel of its accordion is expanded, whether an answer landed while nobody was looking,
// and the one «summon» signal that ⌘K, the circle gesture, the mascot and the session browser
// all send.
//
// A summons is a counter rather than a call into a component, so none of its senders has to
// know where the window lives: the shell's launcher watches it and toggles the window.
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
export const ASSISTANT_MASCOTS = [
  'bot-eyes',
  'bot',
  'drop',
  'tile',
  'eyes',
  'captain',
  'spark',
  'cowboy',
  'cossack',
  'vader',
] as const;
export type AssistantMascotId = (typeof ASSISTANT_MASCOTS)[number];

export const assistantMascot: Ref<AssistantMascotId> = persisted<AssistantMascotId>(
  'kermanych.assistant.mascot',
  ASSISTANT_MASCOTS[0],
  (raw) => ASSISTANT_MASCOTS.find((id) => id === raw) ?? null,
  (id) => id,
);

// The two panels of the window's accordion: ЦУК, and the Менеджмент assistant (managers only).
export type AssistantPanel = 'cuk' | 'management';

export const useAssistantOverlay = defineStore('assistant-overlay', () => {
  const open = ref(false);
  // An answer finished while the window was closed: the mascot wears a dot until it is opened.
  const unread = ref(false);
  const summons = ref(0);
  const panel = ref<AssistantPanel>('cuk');

  // Every opening starts on ЦУК: the console is what the window is for (decision 2).
  function show(): void {
    panel.value = 'cuk';
    open.value = true;
    unread.value = false;
  }

  function close(): void {
    open.value = false;
  }

  function summon(): void {
    summons.value++;
  }

  return { open, unread, summons, panel, show, close, summon };
});
