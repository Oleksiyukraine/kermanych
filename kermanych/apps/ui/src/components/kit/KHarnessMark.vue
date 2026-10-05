<template>
  <!-- claude: the Claude mark KModelMark already carries, in the vendor's own terracotta. -->
  <KModelMark v-if="harness === 'claude'" v-tip="'claude'" class="k-harness-mark k-harness-mark--claude" model="claude" />
  <!-- omp: its π with the plugin connector (assets/icon.svg of can1357/oh-my-pi), minus the
       slots and dots, which are under half a pixel at this size. -->
  <svg
    v-else-if="harness === 'omp'"
    v-tip="'omp'"
    class="k-harness-mark"
    viewBox="10 -5 100 100"
    role="img"
    aria-label="omp"
  >
    <rect x="10" y="8" width="100" height="12" rx="2" fill="currentColor" />
    <rect x="25" y="20" width="12" height="62" rx="2" fill="currentColor" />
    <rect x="75" y="20" width="12" height="45" rx="2" fill="currentColor" />
    <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316" />
  </svg>
  <!-- Kermanych: the top bar's brand mark without its tile, cropped to the glyph. -->
  <svg
    v-else
    v-tip="managedName"
    class="k-harness-mark"
    viewBox="210 132 760 760"
    role="img"
    :aria-label="managedName"
  >
    <path d="M244 214 L344 214 L642 512 L344 810 L244 810 L244 730 L462 512 L244 294 Z" fill="#ff563c" />
    <rect x="636" y="726" width="300" height="84" fill="currentColor" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KModelMark from './KModelMark.vue';
import type { LaunchMode } from '../../lib/native-session';

// The harness running a session — Kermanych's managed session, or omp / claude in their own
// TUI — as the mark the operator knows it by. Keyed by the launcher's «Режим», so the card
// says exactly what was picked there. Brand colours stay fixed (they are logos, not theme
// accents); the neutral strokes follow `currentColor`, so the marks sit in any theme's text.
defineProps<{ harness: LaunchMode }>();

const { t } = useI18n();
const managedName = computed(() => t('agents.native.modeManaged'));
</script>

<style scoped lang="scss">
// Same box as KModelMark: these are filled marks too, and the Claude one IS a KModelMark.
.k-harness-mark {
  display: block;
  flex: none;
  width: var(--k-mark-size, var(--k-icon-sm));
  height: var(--k-mark-size, var(--k-icon-sm));
}

.k-harness-mark--claude {
  color: #d97757;
}
</style>
