<template>
  <!-- Persistent and without a close control: this version no longer works with the shared
       cloud (decision 8 of docs/specs/2026-10-12-desktop-releases-and-updates.md). -->
  <KModal :model-value="upd.unsupported" persistent :title="t('appUpdate.unsupportedTitle')">
    <p>{{ t('appUpdate.unsupportedBody', { current: APP_VERSION, minimum: upd.minVersion ?? '' }) }}</p>
    <p v-if="state.phase === 'downloading'">{{ t('appUpdate.unsupportedDownloading', { version: state.version }) }}</p>
    <p v-else-if="state.phase === 'idle'">{{ t('appUpdate.unsupportedChecking') }}</p>
    <p>
      <a :href="RELEASES_URL" target="_blank" rel="noopener">{{ t('appUpdate.openReleases') }}</a>
    </p>
    <template #controls>
      <KBtn variant="primary" :disabled="state.phase !== 'ready'" @click="upd.install()">{{ t('appUpdate.install') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import { APP_VERSION, RELEASES_URL, useAppUpdate } from '../stores/app-update';

const { t } = useI18n();
const upd = useAppUpdate();
const { state } = storeToRefs(upd);
</script>
