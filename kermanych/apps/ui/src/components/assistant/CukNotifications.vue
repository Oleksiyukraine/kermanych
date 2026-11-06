<template>
  <!-- ЦУК's «Центр сповіщень» (docs/specs/2026-11-04-skill-self-improvement.md, decision 6): the
       window's left column, built like the notepad on the right — a physical object drawn from
       theme tokens. A clipboard: a board with a clip at its head and the notifications as slips
       held on it, newest on top. Its head switches between «Сповіщення» — skill improvements and
       this machine's schedule slips in one feed — and «Розклад», the scheduled tasks
       (docs/specs/2026-11-06-scheduled-tasks.md, decision 6). -->
  <aside class="nc" :aria-label="t('cuk.notifications.title')">
    <div class="nc__clip" aria-hidden="true"><span class="nc__clip-ring"></span></div>
    <div class="nc__board">
      <header class="nc__head">
        <div class="nc__tabs" role="tablist" :aria-label="t('cuk.notifications.title')">
          <button
            class="nc__tab mono"
            :class="{ 'nc__tab--on': store.tab === 'feed' }"
            type="button"
            role="tab"
            :aria-selected="store.tab === 'feed'"
            @click="store.tab = 'feed'"
          >
            {{ t('cuk.notifications.tabs.feed') }}
            <span v-if="store.unread" class="nc__count mono" :aria-label="t('cuk.notifications.count', { n: store.unread })">
              {{ store.unread }}
            </span>
          </button>
          <button
            class="nc__tab mono"
            :class="{ 'nc__tab--on': store.tab === 'schedule' }"
            type="button"
            role="tab"
            :aria-selected="store.tab === 'schedule'"
            @click="store.tab = 'schedule'"
          >{{ t('cuk.notifications.tabs.schedule') }}</button>
        </div>
        <!-- An icon, not the words: the column is 300 px and the tabs must stay readable. -->
        <button
          v-if="store.tab === 'feed' && store.unread"
          class="nc__all"
          type="button"
          :aria-label="t('cuk.notifications.markAll')"
          v-tip="t('cuk.notifications.markAll')"
          :disabled="markAll.busy.value"
          :aria-busy="markAll.busy.value || undefined"
          @click="markAll.run()"
        >✓</button>
      </header>

      <div v-if="store.tab === 'feed'" class="nc__page" role="tabpanel">
        <KSkeleton v-if="feedPhase === 'skeleton'" variant="rows" :rows="4" />
        <template v-else-if="feedPhase === 'ready'">
          <div v-if="store.phase === 'error'" class="nc__blank nc__blank--gap" role="alert">
            <p>{{ t('cuk.notifications.loadFailed', { error: store.error }) }}</p>
            <KBtn variant="ghost" :loading="retry.busy.value" @click="retry.run()">{{ t('cuk.notifications.retry') }}</KBtn>
          </div>
          <p v-if="schedules.loadError && !schedules.slips" class="nc__blank nc__blank--gap" role="alert">
            {{ t('cuk.schedule.loadFailed', { error: schedules.loadError }) }}
          </p>
          <p v-if="!store.feed.length && store.phase !== 'error'" class="nc__blank">{{ t('cuk.notifications.empty') }}</p>
          <ul v-else class="nc__list">
            <li v-for="item in store.feed" :key="item.kind === 'skill-improvement' ? item.entry.id : `slip:${item.slip.id}`">
              <button
                v-if="item.kind === 'skill-improvement'"
                class="nc__slip"
                :class="{
                  'nc__slip--new': !item.entry.seenAt,
                  'nc__slip--open': store.openId === item.entry.id,
                  'nc__slip--settled': item.entry.state !== 'applied',
                }"
                type="button"
                :aria-current="store.openId === item.entry.id || undefined"
                @click="store.open(item.entry.id)"
              >
                <span class="nc__slip-top">
                  <span class="nc__skill mono">{{ item.entry.skillName }}</span>
                  <span class="nc__when mono">{{ renderTime(t, relativeTime(item.entry.createdAt, now)) }}</span>
                </span>
                <span class="nc__summary">{{ item.entry.summary }}</span>
                <span class="nc__meta mono">{{ origin(item.entry) }}</span>
                <span v-if="item.entry.state !== 'applied'" class="nc__state mono">
                  {{ t(`cuk.notifications.state.${item.entry.state}`) }}
                </span>
              </button>
              <ScheduleSlipCard v-else :slip="item.slip" />
            </li>
          </ul>
        </template>
      </div>

      <div v-else class="nc__page" role="tabpanel">
        <KSkeleton v-if="schedulePhase === 'skeleton'" variant="rows" :rows="4" />
        <div v-else-if="schedules.loadError && !schedules.tasks" class="nc__blank" role="alert">
          <p>{{ t('cuk.schedule.loadFailed', { error: schedules.loadError }) }}</p>
          <KBtn variant="ghost" :loading="reloadSchedules.busy.value" @click="reloadSchedules.run()">{{ t('cuk.notifications.retry') }}</KBtn>
        </div>
        <p v-else-if="schedules.tasks && !schedules.tasks.length" class="nc__blank">{{ t('cuk.schedule.empty') }}</p>
        <ul v-else-if="schedules.tasks" class="nc__list">
          <ScheduleRow v-for="task in sortedTasks" :key="task.id" :task="task" />
        </ul>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
// Reads stores/notification-center.ts, which follows the signed-in user for the life of the app,
// and stores/schedules.ts; this component only paints them. An improvement's slip opens the entry
// view over the console, a «Розклад» row the task's view (the launcher renders both).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SkillImprovementEntry } from '@kermanych/core';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useNow } from '../../composables/useNow';
import { relativeTime, renderTime } from '../../lib/time';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import ScheduleRow from './ScheduleRow.vue';
import ScheduleSlipCard from './ScheduleSlipCard.vue';

const { t } = useI18n();
const store = useNotificationCenter();
const schedules = useSchedules();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);

// The feed waits for both sources: a cloud read in flight, or slips the local api has not
// answered yet (unless that read failed — the cloud rows then show with the error above them).
const feedPhase = useLoadPhase(
  () => store.phase === 'loading' || store.phase === 'idle' || (!schedules.slips && !schedules.loadError),
);
const schedulePhase = useLoadPhase(() => !schedules.tasks && !schedules.loadError);

// What fires soonest on top; paused and finished tasks after them, by name.
const sortedTasks = computed(() =>
  [...(schedules.tasks ?? [])].sort((a, b) => {
    const an = a.enabled && a.nextAt ? Date.parse(a.nextAt) : Infinity;
    const bn = b.enabled && b.nextAt ? Date.parse(b.nextAt) : Infinity;
    return an - bn || a.name.localeCompare(b.name);
  }),
);

// A failure is the default toast: the list itself stays as it was.
const markAll = useAsyncAction(() => store.markAllSeen());
const retry = useAsyncAction(() => store.reload());
const reloadSchedules = useAsyncAction(() => schedules.load());

// «сесія · проєкт». The project is named from the cloud list first, then this machine's own
// registry (a local-only project); a project neither knows is left out rather than shown as an id.
function origin(e: SkillImprovementEntry): string {
  const project = e.projectId
    ? (projects.byId.get(e.projectId)?.name ?? local.projects.find((p) => p.id === e.projectId)?.name)
    : undefined;
  return [e.sessionName, project].filter(Boolean).join(' · ');
}
</script>

<style scoped lang="scss">
.nc {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  // Room above the board for the clip to grip its top edge.
  padding-top: 12px;
}

// The clip: a metal bar across the board's head with a ring, the way a clipboard holds paper.
.nc__clip {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 50%;
  width: 96px;
  height: 26px;
  transform: translateX(-50%);
  border-radius: 7px 7px 4px 4px;
  border: 1.5px solid var(--k-muted);
  background: linear-gradient(to bottom, var(--k-surface2), var(--k-line-strong));
  box-shadow: 0 2px 0 color-mix(in srgb, #000 30%, transparent);
  pointer-events: none;
}

.nc__clip-ring {
  position: absolute;
  top: -7px;
  left: 50%;
  width: 26px;
  height: 12px;
  transform: translateX(-50%);
  border: 1.5px solid var(--k-muted);
  border-bottom: none;
  border-radius: 13px 13px 0 0;
}

.nc__board {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 22px var(--k-sp-2) var(--k-sp-2);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  // The board under the slips: a step off the paper's tone, so each slip reads as laid on it. The
  // tint is laid over an opaque surface: in the narrow layout the board slides over ЦУК's
  // transcript, and the theme's line colours are translucent.
  background:
    linear-gradient(color-mix(in srgb, var(--k-line-strong) 45%, transparent), color-mix(in srgb, var(--k-line-strong) 45%, transparent)),
    var(--k-surface);
  box-shadow: var(--k-shadow-toast);
  overflow: hidden;
}

.nc__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  padding: var(--k-sp-2) var(--k-sp-2) var(--k-sp-3);
}

// «Сповіщення | Розклад»: two words in the head's uppercase mono, the active one in full ink
// with the accent under it.
.nc__tabs {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  min-width: 0;
}

.nc__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  padding: 2px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-muted);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: none;
    box-shadow: var(--k-glow-focus);
  }
}

.nc__tab--on {
  border-bottom-color: var(--k-accent);
  color: var(--k-text);
}

.nc__count {
  flex: none;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: var(--k-fs-xs);
  text-align: center;
}

.nc__all {
  flex: none;
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: var(--k-surface);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  &:disabled {
    cursor: progress;
    opacity: 0.6;
  }
}

.nc__page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.nc__blank {
  margin: 0;
  padding: var(--k-sp-3);
  border-radius: var(--k-r);
  background: var(--k-surface);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);

  p {
    margin: 0 0 var(--k-sp-2);
  }
}

.nc__blank--gap {
  margin-bottom: var(--k-sp-2);
}

.nc__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

// One slip of paper on the board.
.nc__slip {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: var(--k-sp-2) var(--k-sp-3) var(--k-sp-2) calc(var(--k-sp-3) + 3px);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-card);
  color: var(--k-text);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--k-line-strong);
    box-shadow: var(--k-shadow-card-hover);
  }

  &:focus-visible {
    outline: none;
    box-shadow: var(--k-glow-focus);
  }
}

// New: the accent edge on the slip's left, the way an unread row is marked elsewhere.
.nc__slip--new::before {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--k-accent);
}

.nc__slip--open {
  border-color: var(--k-accent);
}

// Rolled back or shared: still listed, as a record, but quieter than what is in force.
.nc__slip--settled {
  opacity: 0.72;
}

.nc__slip-top {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  min-width: 0;
}

.nc__skill {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
}

.nc__when {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.nc__summary {
  font-size: var(--k-fs-sm);
  line-height: 1.4;
}

.nc__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.nc__state {
  align-self: flex-start;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
</style>
