import { ref } from 'vue';
import type { MachineResources } from '@kermanych/core';

type Tr = (key: string, named?: Record<string, unknown>, plural?: number) => string;

// «48 GB · 14 ядер (10 продуктивних + 4 енергоощадних) → профіль «Потужна»». Shared by the
// popup and the settings pane so both describe the machine in the same words. The core split
// is left out where the platform does not report one (perfCores falls back to cores).
export function hardwareLine(t: Tr, r: MachineResources): string {
  const hw = r.hardware;
  const gb = Math.round(hw.ramBytes / 1024 ** 3);
  const cores = t('settings.resources.cores', { n: hw.cores }, hw.cores);
  const split =
    hw.perfCores < hw.cores
      ? ' ' + t('settings.resources.coreSplit', { perf: hw.perfCores, eff: hw.cores - hw.perfCores })
      : '';
  return t('settings.resources.hardware', {
    gb,
    cores: cores + split,
    tier: t('settings.resources.tiers.' + r.tier),
  });
}

// The consent popup lives in MainLayout, but two places open it: the layout itself on start,
// and «Визначити заново» in Settings → «Ресурси машини». Module-level refs rather than a
// pinia store: nothing here outlives the window or needs devtools, it is one hand-off.

// What the open popup offers; null while it is closed.
const offer = ref<MachineResources | null>(null);
// Bumped whenever the popup stores a decision, so an open settings pane re-reads instead of
// keeping a decision the popup just replaced.
const decided = ref(0);

export function useResourcesConsent() {
  return {
    offer,
    decided,
    open(r: MachineResources): void {
      offer.value = r;
    },
    close(): void {
      offer.value = null;
    },
    markDecided(): void {
      decided.value += 1;
    },
  };
}
