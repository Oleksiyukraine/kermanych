<template>
  <div v-if="upd.readyVersion && !upd.bannerDismissed" class="aub" role="status">
    <span class="aub__text">
      <b>{{ t('appUpdate.ready', { version: upd.readyVersion }) }}</b>
      <span class="aub__hint">{{ t('appUpdate.readyHint') }}</span>
    </span>
    <KBtn variant="ghost" @click="upd.openReadyNotes()">{{ t('appUpdate.whatsNew') }}</KBtn>
    <KBtn variant="primary" @click="onRestart">{{ t('appUpdate.restart') }}</KBtn>
    <KIconButton :title="t('appUpdate.dismiss')" @click="upd.bannerDismissed = true">✕</KIconButton>
  </div>

  <KModal v-model="confirmOpen" :title="t('appUpdate.confirmTitle')">
    <p>{{ t('appUpdate.confirmBody', { count: activeCount }) }}</p>
    <template #controls>
      <KBtn variant="ghost" @click="confirmOpen = false">{{ t('appUpdate.cancel') }}</KBtn>
      <KBtn variant="primary" @click="upd.install()">{{ t('appUpdate.confirmRestart') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// A downloaded update (decision 7 of docs/specs/2026-10-12-desktop-releases-and-updates.md):
// never installs by itself while the app runs. «Restart» goes straight through when no agent is
// working, and asks first when some are — the restart stops them (before-quit closes the api).
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KModal from 'components/kit/KModal.vue';
import { useAppUpdate } from '../stores/app-update';
import { useOrchestrator } from '../stores/orchestrator';

const { t } = useI18n();
const upd = useAppUpdate();
const orchestrator = useOrchestrator();
const confirmOpen = ref(false);

const activeCount = computed(() => orchestrator.sessions.filter((s) => ACTIVE_STATUSES.includes(s.status)).length);

function onRestart(): void {
  if (activeCount.value > 0) confirmOpen.value = true;
  else upd.install();
}
</script>

<style scoped lang="scss">
.aub {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-1) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  background: var(--k-accent-bg);
  color: var(--k-text);
  font-size: var(--k-fs-xs);
}

.aub__text {
  flex: 1;
  min-width: 0;
}

.aub__hint {
  margin-left: var(--k-sp-2);
  color: var(--k-muted);
}
</style>
