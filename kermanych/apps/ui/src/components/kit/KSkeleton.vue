<template>
  <div
    class="k-skeleton"
    :class="`k-skeleton--${variant}`"
    role="status"
    aria-busy="true"
    :aria-label="label ?? t('kit.skeleton.loading')"
  >
    <template v-if="variant === 'rows'">
      <div v-for="i in rows" :key="i" class="k-skeleton__row">
        <span class="k-skeleton__bar" :style="{ width: rowWidth(i) }" />
        <span class="k-skeleton__bar k-skeleton__bar--short" />
      </div>
    </template>
    <template v-else-if="variant === 'card'">
      <div v-for="i in rows" :key="i" class="k-skeleton__card">
        <span class="k-skeleton__bar" :style="{ width: rowWidth(i) }" />
        <span class="k-skeleton__bar k-skeleton__bar--thin" style="width: 45%" />
        <span class="k-skeleton__bar k-skeleton__bar--thin" style="width: 70%" />
      </div>
    </template>
    <template v-else-if="variant === 'lines'">
      <span v-for="i in rows" :key="i" class="k-skeleton__bar" :style="{ width: i === rows ? '55%' : rowWidth(i) }" />
    </template>
    <span
      v-else
      class="k-skeleton__bar"
      :class="`k-skeleton__bar--${variant}`"
      :style="{ width: width ?? (variant === 'avatar' ? undefined : '100%'), height }"
    />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// The «not loaded yet» placeholder (README «Design → Async states»): flat `--k-line` blocks,
// radius 0, shaped like the content they stand in for, with a slow opacity pulse — static
// under reduced motion. Purely visual: WHEN it shows is the caller's `useLoadPhase`, which
// owns the 150 ms delay and the 300 ms minimum, so a fast load never flashes grey.
//
// - `line`   — one text line (`width` sets its length)
// - `lines`  — a paragraph of `rows` lines
// - `block`  — a box (`width` × `height`): an image, a chart, a stat
// - `avatar` — a 22px square
// - `rows`   — `rows` table / list rows
// - `card`   — `rows` stacked cards (sessions, kanban cards, threads)
const props = withDefaults(
  defineProps<{
    variant?: 'line' | 'lines' | 'block' | 'avatar' | 'rows' | 'card';
    rows?: number;
    width?: string;
    height?: string;
    /** Accessible name; defaults to «Завантаження…». */
    label?: string;
  }>(),
  { variant: 'line', rows: 3 },
);

const { t } = useI18n();

// Ragged right edge, deterministic per row, so a list of placeholders reads as text, not bars.
const WIDTHS = ['92%', '78%', '86%', '64%', '81%', '70%'];
function rowWidth(i: number): string {
  return props.width ?? WIDTHS[(i - 1) % WIDTHS.length]!;
}
</script>

<style scoped lang="scss">
.k-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
}

.k-skeleton--avatar,
.k-skeleton--line,
.k-skeleton--block {
  display: inline-flex;
  width: auto;
}

.k-skeleton__bar {
  display: block;
  height: 10px;
  background: var(--k-line);
  border-radius: 0;
  animation: k-skeleton-pulse 1.2s ease-in-out infinite;
}

.k-skeleton__bar--thin {
  height: 8px;
}

.k-skeleton__bar--short {
  width: 18%;
  flex: none;
}

.k-skeleton__bar--block {
  min-height: 48px;
}

.k-skeleton__bar--avatar {
  width: 22px;
  height: 22px;
}

.k-skeleton__row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  padding: var(--k-sp-2) 0;
  border-bottom: 1px solid var(--k-line);

  .k-skeleton__bar:first-child {
    flex: 1 1 auto;
  }
}

.k-skeleton__card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border: 1px solid var(--k-line);
}

@keyframes k-skeleton-pulse {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-skeleton__bar {
    animation: none;
    opacity: 0.75;
  }
}
</style>
