<template>
  <!-- One ЦУК action that waits for the operator (docs/specs/2026-11-04-cuk-control-console.md,
       decision 4): what will happen, the text editable before it does, «Виконати» / «Скасувати».
       After either, the card stays in the transcript as the record of the decision. A schedule
       action (docs/specs/2026-11-06-scheduled-tasks.md, decision 7) also shows the project or
       «без проєкту», the skills, the schedule in words and its next three firings. -->
  <article class="cukcard" :class="`cukcard--${state}`" :aria-label="kindLabel">
    <header class="cukcard__head">
      <span class="cukcard__kind mono">{{ kindLabel }}</span>
      <span v-if="state !== 'pending'" class="cukcard__state mono">{{ t(`cuk.card.state.${state}`) }}</span>
    </header>

    <dl v-if="!sched" class="cukcard__facts">
      <template v-if="'project' in action">
        <dt>{{ t('cuk.card.project') }}</dt>
        <dd>{{ action.project }}</dd>
      </template>
      <template v-if="'session' in action">
        <dt>{{ t('cuk.card.session') }}</dt>
        <dd>{{ sessionName }}</dd>
      </template>
    </dl>

    <template v-if="sched">
      <dl class="cukcard__facts">
        <template v-if="'ref' in action">
          <dt>{{ t('cuk.card.scheduleTask') }}</dt>
          <dd>{{ sched.task?.name ?? t('cuk.card.scheduleMissing', { ref: action.ref }) }}</dd>
        </template>
        <template v-if="newName">
          <dt>{{ t('cuk.card.name') }}</dt>
          <dd>{{ newName }}</dd>
        </template>
        <template v-if="sched.kind">
          <dt>{{ t('cuk.card.type') }}</dt>
          <dd>{{ t(`cuk.schedule.kind.${sched.kind}`) }}</dd>
        </template>
        <template v-if="sched.kind === 'agent'">
          <dt>{{ t('cuk.card.project') }}</dt>
          <dd>{{ sched.project || t('cuk.card.noProject') }}</dd>
          <dt>{{ t('cuk.card.skills') }}</dt>
          <dd>{{ sched.skills.length ? sched.skills.join(', ') : t('cuk.card.noSkills') }}</dd>
          <template v-if="sched.model">
            <dt>{{ t('cuk.card.model') }}</dt>
            <dd>{{ sched.model }}</dd>
          </template>
        </template>
        <template v-if="sched.words">
          <dt>{{ t('cuk.card.when') }}</dt>
          <dd>{{ sched.words }}</dd>
        </template>
        <template v-if="sched.next.length && action.kind !== 'schedule.delete' && action.kind !== 'schedule.run'">
          <dt>{{ t('cuk.card.next') }}</dt>
          <dd>
            <ul class="cukcard__firings mono">
              <li v-for="at in sched.next" :key="at">{{ at }}</li>
            </ul>
          </dd>
        </template>
      </dl>
      <label v-if="promptEditable" class="cukcard__field">
        <span class="cukcard__label mono">{{ t(sched.kind === 'reminder' ? 'cuk.card.reminderText' : 'cuk.card.prompt') }}</span>
        <textarea v-model="text" class="cukcard__input cukcard__input--area" rows="4" :disabled="state !== 'pending'"></textarea>
      </label>
      <p v-else-if="sched.task" class="cukcard__prompt">{{ sched.task.prompt }}</p>
      <p v-if="action.kind === 'schedule.delete'" class="cukcard__note" role="note">{{ t('cuk.card.deleteNote') }}</p>
    </template>

    <template v-if="action.kind === 'task.create' || action.kind === 'agent.start'">
      <label class="cukcard__field">
        <span class="cukcard__label mono">{{ t('cuk.card.title') }}</span>
        <input
          v-model="title"
          class="cukcard__input"
          type="text"
          :maxlength="CUK_TITLE_MAX"
          :placeholder="titlePlaceholder"
          :disabled="state !== 'pending'"
        />
      </label>
      <label class="cukcard__field">
        <span class="cukcard__label mono">{{ t('cuk.card.task') }}</span>
        <textarea v-model="text" class="cukcard__input cukcard__input--area" rows="4" :disabled="state !== 'pending'"></textarea>
      </label>
      <KCheckbox v-model="deep" :label="t('cuk.card.deep')" :disabled="state !== 'pending'" />
    </template>
    <label v-else-if="action.kind === 'session.message'" class="cukcard__field">
      <span class="cukcard__label mono">{{ t('cuk.card.message') }}</span>
      <textarea v-model="text" class="cukcard__input cukcard__input--area" rows="3" :disabled="state !== 'pending'"></textarea>
    </label>

    <footer v-if="state === 'pending' || state === 'running'" class="cukcard__foot">
      <KBtn variant="ghost" :disabled="state === 'running'" @click="emit('cancel')">{{ t('cuk.card.cancel') }}</KBtn>
      <KBtn variant="primary" :loading="state === 'running'" :disabled="!canRun" @click="run">{{ t('cuk.card.run') }}</KBtn>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  CUK_TITLE_MAX,
  describeSchedule,
  nextOccurrences,
  resolveWhen,
  taskNameFromText,
  type CukAction,
  type CukScheduleAction,
  type ScheduleKind,
  type ScheduleSpec,
  type ScheduledTask,
} from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useSchedules } from 'stores/schedules';
import type { CukCardState } from 'stores/cuk-chat';
import { findSessionByRef } from '../../lib/cuk-digest';
import { formatFiring, machineTimeZone } from '../../lib/schedules';
import { locale } from '../../lib/locale';
import { useNow } from '../../composables/useNow';

const props = defineProps<{ action: CukAction; state: CukCardState }>();
const emit = defineEmits<{ confirm: [action: CukAction]; cancel: [] }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
const schedules = useSchedules();
const now = useNow(60_000);

const scheduleAction = computed<CukScheduleAction | undefined>(() =>
  props.action.kind.startsWith('schedule.') ? (props.action as CukScheduleAction) : undefined,
);
// The task a ref-based schedule action names, when this machine has it.
const scheduleTask = computed<ScheduledTask | undefined>(() => {
  const a = scheduleAction.value;
  return a && 'ref' in a ? schedules.findByRef(a.ref) : undefined;
});

// The card's working copy: the operator edits these, «Виконати» hands the result back.
function initialText(): string {
  const a = props.action;
  if (a.kind === 'session.message') return a.text;
  if (a.kind === 'task.create' || a.kind === 'agent.start') return a.task;
  if (a.kind === 'schedule.create') return a.text;
  if (a.kind === 'schedule.update') return a.text ?? scheduleTask.value?.prompt ?? '';
  return '';
}
const text = ref(initialText());
const title = ref(props.action.kind === 'task.create' || props.action.kind === 'agent.start' ? (props.action.title ?? '') : '');
const deep = ref(props.action.kind === 'task.create' || props.action.kind === 'agent.start' ? !!props.action.deepAnalysis : false);

// Message keys cannot hold a dot (vue-i18n reads it as a path), so `session.stop` → `session_stop`.
const kindLabel = computed(() => t(`cuk.card.kind.${props.action.kind.replace('.', '_')}`));
// The launcher's own rule for a name nobody typed — so the placeholder is the title it will get.
const titlePlaceholder = computed(() => taskNameFromText(text.value));

const sessionName = computed(() => {
  if (!('session' in props.action)) return '';
  return findSessionByRef(store.sessions, props.action.session)?.name ?? props.action.session;
});

function projectName(id: string): string {
  return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? '';
}

// What a schedule card shows: the action's own fields over the task's current ones. A «через N
// хв» is previewed against now; the executor resolves it again when «Виконати» runs it.
const sched = computed(() => {
  const a = scheduleAction.value;
  if (!a) return undefined;
  const task = scheduleTask.value;
  const edit = a.kind === 'schedule.create' || a.kind === 'schedule.update' ? a : undefined;
  const kind: ScheduleKind | undefined = a.kind === 'schedule.create' ? a.type : task?.kind;
  const timeZone = task?.timeZone ?? machineTimeZone();
  const at = new Date(now.value);
  let spec: ScheduleSpec | undefined = task?.schedule;
  if (edit?.when) spec = resolveWhen(edit.when, at, timeZone);
  return {
    task,
    kind,
    project: edit?.project ?? (task?.projectId ? projectName(task.projectId) : ''),
    skills: edit?.skills ?? task?.skills ?? [],
    model: edit?.model ?? task?.model,
    words: spec ? describeSchedule(spec, locale.value) : '',
    next: spec ? nextOccurrences(spec, timeZone, at, 3).map((d) => formatFiring(d, timeZone, locale.value)) : [],
  };
});

const newName = computed(() => {
  const a = props.action;
  return a.kind === 'schedule.create' || a.kind === 'schedule.update' ? (a.name ?? '') : '';
});

// Created or edited, the task's prompt is editable on the card; the other verbs show it as is.
const promptEditable = computed(() => props.action.kind === 'schedule.create' || (props.action.kind === 'schedule.update' && !!(props.action.text !== undefined || scheduleTask.value)));

const needsText = computed(() => ['task.create', 'agent.start', 'session.message'].includes(props.action.kind) || promptEditable.value);
const canRun = computed(() => props.state === 'pending' && (!needsText.value || text.value.trim() !== ''));

function run(): void {
  const a = props.action;
  if (a.kind === 'task.create' || a.kind === 'agent.start') {
    const name = title.value.trim();
    emit('confirm', {
      kind: a.kind,
      project: a.project,
      task: text.value.trim(),
      ...(name ? { title: name } : {}),
      ...(deep.value ? { deepAnalysis: true } : {}),
    });
    return;
  }
  if (a.kind === 'session.message' || a.kind === 'schedule.create') {
    emit('confirm', { ...a, text: text.value.trim() });
    return;
  }
  if (a.kind === 'schedule.update') {
    // The prompt goes into the edit only when the action named one or the operator changed it.
    const next = text.value.trim();
    const changed = a.text !== undefined || next !== (scheduleTask.value?.prompt ?? '').trim();
    emit('confirm', changed ? { ...a, text: next } : a);
    return;
  }
  emit('confirm', a);
}
</script>

<style scoped lang="scss">
// A card, not a line: it is the one thing in the transcript that waits for a decision, so it is
// boxed and carries the accent edge until the decision is made.
.cukcard {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-left: 2px solid var(--k-accent);
  border-radius: var(--k-r);
  background: color-mix(in srgb, var(--k-surface2) 45%, transparent);
}

.cukcard--done,
.cukcard--cancelled {
  border-left-color: var(--k-line-strong);
  opacity: 0.8;
}

.cukcard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
}

.cukcard__kind {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--k-text);
}

.cukcard__state {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cukcard__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--k-sp-3);
  margin: 0;
  font-size: var(--k-fs-sm);

  dt {
    color: var(--k-muted);
  }

  dd {
    margin: 0;
    color: var(--k-text);
    overflow-wrap: anywhere;
  }
}

.cukcard__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cukcard__label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cukcard__input {
  width: 100%;
  padding: 6px var(--k-sp-2);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  background: var(--k-surface);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }

  &:disabled {
    color: var(--k-muted);
  }

  &::placeholder {
    color: var(--k-faint);
  }
}

.cukcard__input--area {
  resize: vertical;
}

// The next three firings, one per line: the operator checks «щогодини» against real hours.
.cukcard__firings {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--k-fs-xs);
}

.cukcard__prompt {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  white-space: pre-line;
  color: var(--k-muted);
}

.cukcard__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-danger);
}

.cukcard__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
}
</style>
