<template>
  <!-- ЦУК's «Центр сповіщень» (docs/specs/2026-11-04-skill-self-improvement.md, decision 6): the
       window's left column, built like the notepad on the right — a physical object drawn from
       theme tokens. A clipboard: a board with a clip at its head and the notifications as slips
       held on it, newest on top. Its head switches between «Сповіщення» — skill improvements,
       this machine's schedule slips and the updates of Kermanych this machine received, in one
       feed — «Розклад», the scheduled tasks (docs/specs/2026-11-06-scheduled-tasks.md,
       decision 6; docs/specs/2026-10-12-desktop-releases-and-updates.md, decision 12), and
       «Оновлення», this build's changelog (docs/specs/2026-11-16-changelog-tab.md). -->
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
            <span class="nc__tab-label">{{ t('cuk.notifications.tabs.feed') }}</span>
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
          ><span class="nc__tab-label">{{ t('cuk.notifications.tabs.schedule') }}</span></button>
          <button
            class="nc__tab mono"
            :class="{ 'nc__tab--on': store.tab === 'changelog' }"
            type="button"
            role="tab"
            :aria-selected="store.tab === 'changelog'"
            @click="store.tab = 'changelog'"
          ><span class="nc__tab-label">{{ t('cuk.notifications.tabs.changelog') }}</span></button>
        </div>
      </header>

      <div v-if="store.tab === 'feed'" class="nc__page" role="tabpanel">
        <KSkeleton v-if="feedPhase === 'skeleton'" variant="rows" :rows="4" />
        <template v-else-if="feedPhase === 'ready'">
          <!-- Under the tabs, not beside them: three tabs and the unread count fill the 300 px head. -->
          <div v-if="store.unread" class="nc__bar">
            <KBtn variant="ghost" :loading="markAll.busy.value" @click="markAll.run()">✓ {{ t('cuk.notifications.markAll') }}</KBtn>
          </div>
          <div v-if="store.phase === 'error'" class="nc__blank nc__blank--gap" role="alert">
            <p>{{ t('cuk.notifications.loadFailed', { error: store.error }) }}</p>
            <KBtn variant="ghost" :loading="retry.busy.value" @click="retry.run()">{{ t('cuk.notifications.retry') }}</KBtn>
          </div>
          <p v-if="schedules.loadError && !schedules.slips" class="nc__blank nc__blank--gap" role="alert">
            {{ t('cuk.schedule.loadFailed', { error: schedules.loadError }) }}
          </p>
          <p v-if="!store.feed.length && store.phase !== 'error'" class="nc__blank">{{ t('cuk.notifications.empty') }}</p>
          <ul v-else class="nc__list">
            <li
              v-for="item in store.feed"
              :key="item.kind === 'skill-improvement' ? item.entry.id : item.kind === 'app-update' ? item.update.id : `slip:${item.slip.id}`"
            >
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
              <!-- An update opens its «What's new» (AppWhatsNew.vue), not the entry view. -->
              <button
                v-else-if="item.kind === 'app-update'"
                class="nc__slip"
                :class="{ 'nc__slip--new': !item.update.seenAt }"
                type="button"
                @click="appUpdate.openUpdate(item.update.id)"
              >
                <span class="nc__slip-top">
                  <span class="nc__skill mono">{{ t('cuk.notifications.update.title', { version: item.update.version }) }}</span>
                  <span class="nc__when mono">{{ renderTime(t, relativeTime(item.update.createdAt, now)) }}</span>
                </span>
                <span class="nc__summary">{{ t('cuk.notifications.update.summary', { from: item.update.from }) }}</span>
              </button>
              <ScheduleSlipCard v-else :slip="item.slip" />
            </li>
          </ul>
        </template>
      </div>

      <div v-else-if="store.tab === 'schedule'" class="nc__page" role="tabpanel">
        <KSkeleton v-if="schedulePhase === 'skeleton'" variant="rows" :rows="4" />
        <div v-else-if="schedules.loadError && !schedules.tasks" class="nc__blank" role="alert">
          <p>{{ t('cuk.schedule.loadFailed', { error: schedules.loadError }) }}</p>
          <KBtn variant="ghost" :loading="reloadSchedules.busy.value" @click="reloadSchedules.run()">{{ t('cuk.notifications.retry') }}</KBtn>
        </div>
        <p v-else-if="schedules.tasks && !schedules.tasks.length" class="nc__blank">{{ t('cuk.schedule.empty') }}</p>
        <p v-else-if="schedules.tasks && !sortedTasks.length" class="nc__blank">{{ t('cuk.schedule.emptyWorkspace') }}</p>
        <ul v-else-if="schedules.tasks" class="nc__list">
          <ScheduleRow v-for="task in sortedTasks" :key="task.id" :task="task" />
        </ul>
      </div>

      <!-- Bundled with the build (stores/app-update.ts): nothing to load, so no skeleton. A version
           opens its notes over the console (ChangelogEntryView), like a slip of the feed. -->
      <div v-else class="nc__page" role="tabpanel">
        <p v-if="!versions.length" class="nc__blank">{{ t('cuk.notifications.changelog.empty') }}</p>
        <ul v-else class="nc__list">
          <li v-for="v in versions" :key="v.version">
            <button
              class="nc__slip"
              :class="{ 'nc__slip--open': store.openVersion === v.version }"
              type="button"
              :aria-current="store.openVersion === v.version || undefined"
              @click="store.openChangelog(v.version)"
            >
              <span class="nc__slip-top">
                <span class="nc__skill mono">{{ t('cuk.notifications.changelog.title', { version: v.version }) }}</span>
                <span v-if="v.date" class="nc__when mono">{{ v.date }}</span>
              </span>
              <span v-if="v.summary" class="nc__summary nc__summary--clamp">{{ v.summary }}</span>
              <span v-else class="nc__meta">{{ t('appUpdate.noNotes') }}</span>
              <span v-if="v.version === APP_VERSION" class="nc__state mono">{{ t('cuk.notifications.changelog.current') }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
// Reads stores/notification-center.ts, which follows the signed-in user for the life of the app,
// and stores/schedules.ts; this component only paints them. An improvement's slip opens the entry
// view over the console, a schedule slip its details, a «Розклад» row the task's view, an
// «Оновлення» row the version's notes (the launcher renders them).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { changelogSummary, type SkillImprovementEntry } from '@kermanych/core';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { APP_VERSION, useAppUpdate } from 'stores/app-update';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useNow } from '../../composables/useNow';
import { relativeTime, renderTime } from '../../lib/time';
import { tasksInWorkspace } from '../../lib/schedules';
import { sessionScopedProjectIds } from '../../lib/scope';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import ScheduleRow from './ScheduleRow.vue';
import ScheduleSlipCard from './ScheduleSlipCard.vue';

const { t } = useI18n();
const store = useNotificationCenter();
const schedules = useSchedules();
const appUpdate = useAppUpdate();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);

// The feed waits for both sources: a cloud read in flight, or slips the local api has not
// answered yet (unless that read failed — the cloud rows then show with the error above them).
const feedPhase = useLoadPhase(
  () => store.phase === 'loading' || store.phase === 'idle' || (!schedules.slips && !schedules.loadError),
);
const schedulePhase = useLoadPhase(() => !schedules.tasks && !schedules.loadError);

// Only the selected workspace's tasks, like the notepad on the right (lib/schedules.ts
// tasksInWorkspace); its projects are read as the Агенти page reads them, from the cached map
// while the cloud list is unread.
const scopedTasks = computed(() => {
  const workspaceId = local.selectedWorkspaceId;
  const ids = workspaceId
    ? sessionScopedProjectIds({ workspaceId }, { projects: projects.projects, listRead: projects.listRead }, local.projectWorkspace)
    : undefined;
  return tasksInWorkspace(schedules.tasks ?? [], ids);
});

// What fires soonest on top; paused and finished tasks after them, by name.
const sortedTasks = computed(() =>
  [...scopedTasks.value].sort((a, b) => {
    const an = a.enabled && a.nextAt ? Date.parse(a.nextAt) : Infinity;
    const bn = b.enabled && b.nextAt ? Date.parse(b.nextAt) : Infinity;
    return an - bn || a.name.localeCompare(b.name);
  }),
);

// «Оновлення»: each version's heading, date and first note. The changelog is bundled, so this is
// worked out once.
const versions = appUpdate.changelog.map((e) => ({ version: e.version, date: e.date, summary: changelogSummary(e.body) }));

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
  // Room above the board for the clip to grip its top edge: the window's lip
  // (AssistantLauncher.vue), so the board's top lines up with the notepad and the middle column.
  padding-top: var(--asst-ovl-lip);
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

// «Сповіщення | Розклад | Оновлення»: words in the head's uppercase mono, the active one in full
// ink with the accent under it. Three equal thirds of the head; the unread count rides on the
// first tab's corner as a badge, so it takes no width from the word.
.nc__tabs {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: var(--k-sp-1);
  min-width: 0;
}

.nc__tab {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 0;
  padding: 2px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.06em;
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

.nc__tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc__tab--on {
  border-bottom-color: var(--k-accent);
  color: var(--k-text);
}

.nc__count {
  position: absolute;
  top: -9px;
  right: -2px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: 10px;
  line-height: 14px;
  letter-spacing: 0;
  text-align: center;
}

// «✓ Позначити все прочитаним» above the feed, at its right.
.nc__bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--k-sp-1);
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

// An «Оновлення» row's first note: a preview, the whole text is one click away.
.nc__summary--clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
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
