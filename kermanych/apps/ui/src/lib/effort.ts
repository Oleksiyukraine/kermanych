import { THINKING_LEVELS, type ThinkingLevel } from '@kermanych/core';

// The operator-facing names for omp's reasoning-effort ladder. The wire values stay omp's
// (`off`…`max` — see packages/core/src/thinking.ts); only the words are ours, and they live in
// the catalog under `common.effort.*`, resolved at the callsite so the chip follows the locale.
// They are masculine to agree with «рівень роздумів», which is what the composer chip is naming.
//
// `off` gets a phrase rather than «Вимкнено»: the chip shows this word beside a ⚡ icon with
// no other context, and a bare "off" there reads as "the agent is off".
export function effortLabelKey(level: ThinkingLevel): string {
  return `common.effort.${level}`;
}

// Picker options in ladder order (core owns the order). One array, built once: the composer
// re-renders on every keystroke and must not rebuild its menu each time. Each option carries
// its label KEY, not the word — the callsite maps it through `t()` in a computed so the menu
// re-reads on a locale change.
export const EFFORT_OPTIONS: { value: ThinkingLevel; labelKey: string }[] = THINKING_LEVELS.map((value) => ({
  value,
  labelKey: effortLabelKey(value),
}));
