<template>
  <div class="relw">
    <p v-if="store.loadError" class="relw__note relw__note--error mono">
      {{ t('management.home.releases.error', { error: store.loadError }) }}
    </p>
    <p v-else-if="!recent.length" class="relw__note mono">
      {{ t('management.home.releases.empty') }}
    </p>

    <!-- The last five notes, newest first — the store already sorts by createdAt descending, so
         «what did we ship last» is the first line. The whole row routes to the full section, the
         only place a note is read and edited. -->
    <ol v-else class="relw__list">
      <li v-for="n in recent" :key="n.id" class="relw__row">
        <RouterLink class="relw__link" :to="{ name: 'management-releases' }">
          <span class="relw__title">{{ n.title }}</span>
          <span class="relw__meta">
            <KTag>{{ n.projectName }}</KTag>
            <span class="relw__when mono">{{ renderTime(t, relativeTime(n.createdAt, now)) }}</span>
          </span>
        </RouterLink>
      </li>
    </ol>

    <RouterLink v-if="recent.length" class="relw__all mono" :to="{ name: 'management-releases' }">
      {{ t('management.home.releases.open') }} →
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
// The workspace's five most recent release notes, in one tile. It reads the same
// release-notes store the full section does (newest-first per workspace), so a note generated
// anywhere shows up here on the next load. Read-only: a note is opened, copied and edited on its
// own screen, which every row links to.
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { WorkspaceReleaseNote } from '@kermanych/cloud';
import KTag from 'components/kit/KTag.vue';
import { useReleaseNotes } from 'stores/release-notes';
import { useNow } from '../../composables/useNow';
import { relativeTime, renderTime } from '../../lib/time';

const props = defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const store = useReleaseNotes();
const now = useNow(60_000);

watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.load(id);
  },
  { immediate: true },
);

const recent = computed<WorkspaceReleaseNote[]>(() =>
  (store.byWorkspace[props.workspaceId] ?? []).slice(0, 5),
);
</script>

<style scoped lang="scss">
.relw {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  height: 100%;
}

.relw__note {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}

.relw__note--error {
  color: var(--k-danger);
}

.relw__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.relw__row + .relw__row {
  border-top: 1px solid var(--k-line);
}

.relw__link {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-2) 0;
  color: inherit;
  text-decoration: none;
}

.relw__link:hover .relw__title {
  color: var(--k-accent);
}

.relw__title {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relw__meta {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

.relw__when {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.relw__all {
  margin-top: auto;
  align-self: flex-start;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
  text-decoration: none;
}

.relw__all:hover {
  text-decoration: underline;
}
</style>
