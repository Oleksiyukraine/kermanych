<template>
  <div class="taskw">
    <p v-if="jira.integration === null" class="taskw__note mono">
      {{ t('management.home.tasks.gateJira') }}
      <RouterLink class="taskw__link" :to="{ name: 'management-integrations' }">
        {{ t('management.home.capacity.gateOpen') }}
      </RouterLink>
    </p>
    <p v-else-if="jira.integration === undefined" class="taskw__note mono">
      {{ t('management.home.capacity.loading') }}
    </p>
    <p v-else-if="!groups.length" class="taskw__note mono">
      {{ t('management.home.tasks.empty') }}
    </p>

    <!-- One block per developer with work landing on today's date, their tasks under their name.
         «Today» is each ticket's own calendar window: due today, in its start→due span today, or
         overdue and still open — the day it is on someone's plate. -->
    <div v-else class="taskw__groups">
      <section v-for="g in groups" :key="g.id" class="taskw__group">
        <header class="taskw__dev">
          <span class="taskw__dev-name">{{ g.name }}</span>
          <span class="taskw__dev-count mono">{{ t('management.home.tasks.count', { n: g.tasks.length }, g.tasks.length) }}</span>
        </header>
        <ul class="taskw__tasks">
          <li v-for="task in g.tasks" :key="task.key" class="taskw__task">
            <a class="taskw__task-link" :href="issueUrl(task.key)" target="_blank" rel="noopener">
              <span class="taskw__key mono">{{ task.key }}</span>
              <span class="taskw__summary">{{ task.summary }}</span>
              <span v-if="task.overdue" class="taskw__overdue mono">{{ t('management.home.tasks.overdue') }}</span>
            </a>
          </li>
        </ul>
      </section>
    </div>

    <RouterLink v-if="groups.length" class="taskw__all mono" :to="{ name: 'board' }">
      {{ t('management.home.tasks.open') }} →
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
// Today's board, per developer: every open Jira ticket whose calendar window includes today,
// grouped under the person it is assigned to. It reads the Jira session the home page opened
// (stores/jira.ts) — the same mirror the board and Team Capacity read — so the tickets are the
// ones on the board right now. Read-only: the row opens the ticket in Jira.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { JiraIssue } from '@kermanych/cloud';
import { useJira } from 'stores/jira';
import { useNow } from '../../composables/useNow';
import { todayIso } from '../../lib/capacity';
import { UNASSIGNED } from '../../lib/jira-view';

defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const jira = useJira();
const nowMs = useNow(60_000);
const today = computed(() => todayIso(nowMs.value));

// A ticket is «for today» when it is still open and today falls in its planning window: due
// today, inside its start→due span, or overdue (past due but not done — still owed today). A
// ticket with no due date has no specific date to be assigned to, so it is not counted here.
function isForToday(issue: JiraIssue, day: string): boolean {
  if (issue.statusCategory === 'done') return false;
  if (!issue.dueDate) return false;
  if (issue.dueDate <= day) return true; // due today or overdue
  return !!issue.startDate && issue.startDate <= day; // mid-window (started, not yet due)
}

type Task = { key: string; summary: string; overdue: boolean };
type Group = { id: string; name: string; tasks: Task[] };

const groups = computed<Group[]>(() => {
  if (!jira.integration) return [];
  const day = today.value;
  const byPerson: Record<string, Group> = {};
  for (const issue of jira.issues) {
    if (!isForToday(issue, day)) continue;
    const id = issue.assigneeAccountId ?? issue.assigneeName ?? UNASSIGNED;
    const name = issue.assigneeName ?? (id === UNASSIGNED ? t('management.home.tasks.unassigned') : id);
    (byPerson[id] ??= { id, name, tasks: [] }).tasks.push({
      key: issue.key,
      summary: issue.summary,
      overdue: issue.dueDate < day,
    });
  }
  // People first (by workload, busiest first), the Unassigned bucket last — its tickets are a
  // scheduling gap, not one person's day.
  return Object.values(byPerson).sort((a, b) => {
    if (a.id === UNASSIGNED) return 1;
    if (b.id === UNASSIGNED) return -1;
    return b.tasks.length - a.tasks.length || a.name.localeCompare(b.name);
  });
});

function issueUrl(key: string): string {
  const site = jira.integration?.siteUrl ?? '';
  return `${site.replace(/\/$/, '')}/browse/${key}`;
}
</script>

<style scoped lang="scss">
.taskw {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  height: 100%;
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
