<template>
  <KModal
    :model-value="whatsNew !== null"
    :title="title"
    width="560px"
    @update:model-value="(open: boolean) => { if (!open) upd.whatsNew = null; }"
  >
    <p v-if="whatsNew?.entries === null">{{ t('appUpdate.notesLoading') }}</p>
    <p v-else-if="whatsNew && whatsNew.entries.length === 0">
      {{ t('appUpdate.notesUnavailable') }}
      <a :href="RELEASES_URL" target="_blank" rel="noopener">{{ t('appUpdate.openReleases') }}</a>
    </p>
    <div v-else class="awn">
      <section v-for="e in whatsNew?.entries ?? []" :key="e.version" class="awn__entry">
        <h4 class="awn__ver mono">{{ e.version }}<span v-if="e.date" class="awn__date"> · {{ e.date }}</span></h4>
        <!-- html:false (lib/markdown.ts), so the notes render as a controlled tag set. -->
        <div v-if="e.body" class="awn__body" v-html="renderReleaseNotes(e.body)"></div>
        <p v-else class="awn__empty">{{ t('appUpdate.noNotes') }}</p>
      </section>
    </div>
    <template #controls>
      <KBtn variant="primary" @click="upd.whatsNew = null">{{ t('appUpdate.close') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// «What's new» (docs/specs/2026-10-12-desktop-releases-and-updates.md, decision 2): after an
// update, from the update banner before installing, and from Settings → «Загальне».
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import { renderReleaseNotes } from '../lib/markdown';
import { RELEASES_URL, useAppUpdate } from '../stores/app-update';

const { t } = useI18n();
const upd = useAppUpdate();
const { whatsNew } = storeToRefs(upd);

const title = computed(() => {
  const w = whatsNew.value;
  if (!w || w.title === 'all') return t('appUpdate.notesAll');
  return t(w.title === 'ready' ? 'appUpdate.notesReady' : 'appUpdate.notesInstalled', { version: w.version });
});
</script>

<style scoped lang="scss">
.awn {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  max-height: 60vh;
  overflow-y: auto;
  color: var(--k-text);
}

.awn__ver {
  margin: 0 0 var(--k-sp-1);
  font-size: var(--k-fs-md);
  font-weight: 800;
}

.awn__date {
  color: var(--k-muted);
  font-weight: var(--k-fw-medium);
}

.awn__body :deep(ul) {
  margin: 0;
  padding-left: 18px;
}

.awn__body :deep(p) {
  margin: 0 0 var(--k-sp-1);
}

.awn__empty {
  margin: 0;
  color: var(--k-muted);
}
</style>
