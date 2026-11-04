<template>
  <div class="taskw">
    <!-- Which tracker the tile reads, offered only when the workspace has both; the pick is
         shared with the capacity tile (stores/tracker.ts). -->
    <div v-if="src.available.length > 1" class="taskw__toolbar">
      <KChipSelect
        :model-value="src.kind ?? 'jira'"
        :options="TRACKER_SOURCE_OPTIONS"
        :title="t('management.capacity.source')"
        placement="down"
        @update:model-value="(v: string) => src.setKind(v)"
      />
    </div>
    <p v-if="src.integration === null" class="taskw__note mono">
      {{ t('management.home.tasks.gate') }}
      <RouterLink class="taskw__link" :to="{ name: 'management-integrations' }">
        {{ t('management.home.capacity.gateOpen') }}
      </RouterLink>
    </p>
    <!-- Not loaded for this workspace (the tracker stores reset on a switch and keep `loading`
         up through loadBoard): «нічого на сьогодні» would be a claim. -->
    <template v-else-if="phase !== 'ready'">
      <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="4" />
    </template>
    <p v-else-if="!groups.length" class="taskw__note mono">
      {{ t('management.home.tasks.empty') }}
    </p>

    <!-- One block per developer with work landing on today's date, their tasks under their name.
         «Today» is each ticket's own calendar window: due today, in its start→due span today, or
         overdue and still open — the day it is on someone's plate. -->
    <div v-else class="taskw__groups">
      <section v-for="g in groups" :key="g.id" class="taskw__group">
        <header class="taskw__dev">
          <span class="taskw__dev-name">{{ g.name || t('management.home.tasks.unassigned') }}</span>
          <span class="taskw__dev-count mono">{{ t('management.home.tasks.count', { n: g.tasks.length }, g.tasks.length) }}</span>
        </header>
        <ul class="taskw__tasks">
          <li v-for="task in g.tasks" :key="task.key" class="taskw__task">
            <a class="taskw__task-link" :href="src.issueUrl(task.key)" target="_blank" rel="noopener">
              <span class="taskw__key mono">{{ task.key }}</span>
              <span class="taskw__summary">{{ task.summary }}</span>
              <span v-if="task.overdue" class="taskw__overdue mono">{{ t('management.home.tasks.overdue') }}</span>
            </a>
          </li>
        </ul>
      </section>
    </div>

    <RouterLink v-if="phase === 'ready' && groups.length" class="taskw__all mono" :to="{ name: 'board' }">
      {{ t('management.home.tasks.open') }} →
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
// Today's board, per developer: every open Jira or Plane ticket whose calendar window includes
// today, grouped under the person it is assigned to. It reads the tracker sessions the home
// page opened (stores/tracker.ts picks which) — the same mirror the board and Team Capacity
// read — so the tickets are the ones on the board right now. Read-only: the row opens the
// ticket in its tracker.
//
// The grouping itself lives in lib/home-digest.ts, because the management chat sends the
// SAME computation to the assistant on every ask — the two must never disagree about whose
// day holds what.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { useTrackerSource } from 'stores/tracker';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useNow } from '../../composables/useNow';
import { todayIso } from '../../lib/capacity';
import { todayTaskGroups, type TodayGroup } from '../../lib/home-digest';
import { TRACKER_SOURCE_OPTIONS } from '../../lib/tracker-source';

defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const src = useTrackerSource();
const nowMs = useNow(60_000);
const today = computed(() => todayIso(nowMs.value));

// The digest keeps a blank name for the unassigned bucket; the label is render-side.
const groups = computed<TodayGroup[]>(() =>
  src.integration ? todayTaskGroups(src.issues, today.value) : [],
);

const phase = useLoadPhase(() => src.integration === undefined || (src.loading && !src.issues.length));
</script>

<style scoped lang="scss">
.taskw {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  height: 100%;
}

.taskw__toolbar {
  display: flex;
  align-items: center;
}

.taskw__note {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
}

.taskw__link {
  color: var(--k-accent);
  text-decoration: underline;
}

.taskw__groups {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.taskw__dev {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--k-sp-2);
  margin-bottom: var(--k-sp-1);
}

.taskw__dev-name {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.taskw__dev-count {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  flex: none;
}

.taskw__tasks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.taskw__task-link {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  padding: 3px 0;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}

.taskw__task-link:hover .taskw__summary {
  color: var(--k-accent);
}

.taskw__key {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  flex: none;
}

.taskw__summary {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.taskw__overdue {
  flex: none;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--k-danger);
}

.taskw__all {
  margin-top: auto;
  align-self: flex-start;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
  text-decoration: none;
}

.taskw__all:hover {
  text-decoration: underline;
}
</style>
