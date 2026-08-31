import { THINKING_LEVELS, type ThinkingLevel } from '@kermanych/core';

// The operator-facing names for omp's reasoning-effort ladder. The wire values stay omp's
// (`off`…`max` — see packages/core/src/thinking.ts); only the words are ours, and they are
// masculine to agree with «рівень роздумів», which is what the composer chip is naming.
//
// `off` gets a phrase rather than «Вимкнено»: the chip shows this word beside a ⚡ icon with
// no other context, and a bare "off" there reads as "the agent is off".
export const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: 'Без роздумів',
  minimal: 'Мінімальний',
  low: 'Низький',
  medium: 'Середній',
  high: 'Високий',
  xhigh: 'Дуже високий',
  max: 'Максимальний',
};

// Picker options in ladder order (core owns the order). One array, built once: the composer
// re-renders on every keystroke and must not rebuild its menu each time.
export const EFFORT_OPTIONS: { value: ThinkingLevel; label: string }[] = THINKING_LEVELS.map((value) => ({
  value,
  label: EFFORT_LABELS[value],
}));
