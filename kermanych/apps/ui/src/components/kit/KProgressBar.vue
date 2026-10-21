<template>
  <div
    v-if="active"
    class="k-progress-bar"
    role="progressbar"
    :aria-label="t('kit.progress.label')"
    aria-busy="true"
  >
    <span class="k-progress-bar__sweep" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

// The global «something you started is still running» bar: 2px, accent, along the bottom
// edge of the top navigation (the host — MainLayout's q-header — is positioned). MainLayout
// renders exactly one, fed by `useActivity().barVisible` — which already carries the 300 ms
// delay and 300 ms minimum, and counts only foreground work (useAsyncAction / trackLoad), so
// background polling never lights it.
defineProps<{ active: boolean }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}

.k-progress-bar__sweep {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 35%;
  background: var(--k-accent);
  animation: k-progress-sweep 1.1s ease-in-out infinite;
}

@keyframes k-progress-sweep {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}

@keyframes k-progress-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-progress-bar__sweep {
    left: 0;
    width: 100%;
    animation: k-progress-pulse 1.6s ease-in-out infinite;
  }
}
</style>
