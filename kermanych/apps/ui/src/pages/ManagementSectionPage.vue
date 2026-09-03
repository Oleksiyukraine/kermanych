<template>
  <section class="mgmt-section">
    <div class="mgmt-section__card">
      <span class="mgmt-section__badge mono">
        <i class="mgmt-section__pulse" aria-hidden="true"></i>coming soon
      </span>
      <p class="mgmt-section__text">{{ t('management.placeholder.text') }}</p>
      <p class="mgmt-section__scope mono">{{ t('management.placeholder.scope', { name: workspaceName }) }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
// Placeholder body shared by every Менеджмент section. It states the contract a
// real section inherits: the shell only mounts it once a WORKSPACE is selected and
// passes that workspace in, so no section has to handle «no workspace» itself.
//
// Dashed card, not bare text: an empty screen under a finished nav reads as a
// bug, while a card that carries the state and the workspace reads as a promise.
// The section is NOT named again here — the shell's heading and the active tab
// both already say it.
import { useI18n } from 'vue-i18n';
defineProps<{ workspaceId: string; workspaceName: string }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.mgmt-section {
  padding: var(--k-sp-6) 0;
}

.mgmt-section__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-3);
  max-width: 420px;
  padding: var(--k-sp-5);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
  // Settle in on arrival — the only motion on the page, keyed to the route
  // change so switching sections feels like something happened.
  animation: mgmt-rise 0.26s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.mgmt-section__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: 3px var(--k-sp-2);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
  background: color-mix(in srgb, var(--k-accent) 12%, transparent);
  border-radius: var(--k-r-pill);
}

.mgmt-section__pulse {
  width: 5px;
  height: 5px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  animation: mgmt-pulse 2s ease-in-out infinite;
}

.mgmt-section__text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-medium);
  letter-spacing: -0.01em;
  color: var(--k-text);
}

.mgmt-section__scope {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

@keyframes mgmt-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes mgmt-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mgmt-section__card {
    animation: none;
  }

  .mgmt-section__pulse {
    animation: none;
  }
}
</style>
