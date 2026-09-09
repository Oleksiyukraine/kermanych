<template>
  <div
    class="linear-card"
    role="button"
    tabindex="0"
    :draggable="draggable"
    @click="emit('click')"
    @keydown.enter="emit('click')"
    @dragstart="onDragStart"
  >
    <div class="linear-card__head">
      <span class="linear-card__key mono">{{ issue.key }}</span>
      <span
        v-if="issue.priority > 0"
        class="linear-card__prio"
        :class="`linear-card__prio--${issue.priority}`"
        v-tip="t('linear.card.priorityTip', { name: issue.priorityName })"
      ></span>
      <span class="linear-card__spacer"></span>
      <KStatusDot v-if="agentStatus" :status="agentStatus" />
      <KAvatar
        v-if="issue.assigneeName"
        :name="issue.assigneeName"
        :avatar-url="issue.assigneeAvatar"
        :hint="t('linear.card.assigneeTip', { name: issue.assigneeName })"
        :size="18"
      />
    </div>
    <div class="linear-card__summary">{{ issue.title }}</div>
    <div v-if="issue.labels.length || issue.estimate > 0 || dates" class="linear-card__meta">
      <span v-for="label in issue.labels" :key="label" class="linear-card__label mono">{{ label }}</span>
      <span v-if="issue.estimate > 0" class="linear-card__estimate mono">{{ t('linear.card.estimate', { n: issue.estimate }) }}</span>
      <span
        v-if="dates"
        class="linear-card__dates mono"
        :class="`linear-card__dates--${dates.tone}`"
        v-tip="datesHint"
      >{{ datesText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// One mirrored Linear ticket as a board card: identifier + priority dot, title, label
// chips, the estimate in points, the planning dates Linear holds for the ticket, the
// Linear assignee's face, and — when a shadow task runs — the SAME status dot a native
// card wears, so «агент працює на цьому тікеті» reads identically on both views.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LinearIssue } from '@kermanych/cloud';
import type { SessionStatus } from '@kermanych/core';
import KAvatar from 'components/kit/KAvatar.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import { dateChip, todayIso } from '../../lib/linear-view';

const props = defineProps<{
  issue: LinearIssue;
  agentStatus?: SessionStatus | undefined;
  draggable: boolean;
}>();

const emit = defineEmits<{ click: []; dragstart: [] }>();

// `today` is read per render rather than held: a board left open past midnight must not
// keep yesterday's «прострочено» verdict.
const { t } = useI18n();

const dates = computed(() => dateChip(props.issue, todayIso()));
const datesText = computed(() => {
  const d = dates.value;
  if (!d) return '';
  if (d.start && d.due) return `${d.start} – ${d.due}`;
  return d.due ? t('linear.card.dateBy', { due: d.due }) : t('linear.card.dateFrom', { start: d.start });
});
const datesHint = computed(() => {
  const parts: string[] = [];
  if (props.issue.startDate) parts.push(t('linear.card.start', { date: props.issue.startDate }));
  if (props.issue.dueDate) parts.push(t('linear.card.due', { date: props.issue.dueDate }));
  if (dates.value?.tone === 'overdue') parts.push(t('linear.card.overdue'));
  return parts.join(' · ');
});

function onDragStart(e: DragEvent): void {
  if (!props.draggable) return;
  // The payload rides on the component event; dataTransfer only needs to exist for
  // Chromium to allow the drag at all.
  e.dataTransfer?.setData('text/plain', props.issue.key);
  emit('dragstart');
}
</script>

<style scoped lang="scss">
.linear-card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-3);
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 0.12s ease;

  &:hover {
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }
}

.linear-card__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.linear-card__key {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  letter-spacing: 0.02em;
}

// Linear renders priority as an icon; a coloured dot is the mirror's own honest stand-in
// (the numeric scale is not an image the mirror can carry). 1 Urgent is the loud one, then
// High/Medium/Low taper off.
.linear-card__prio {
  width: 8px;
  height: 8px;
  border-radius: var(--k-r-pill);
  background: var(--k-muted);

  &--1 { background: var(--k-danger); }
  &--2 { background: var(--k-warning); }
  &--3 { background: var(--k-accent); }
  &--4 { background: var(--k-faint); }
}

.linear-card__spacer {
  flex: 1;
}

.linear-card__summary {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.linear-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

// The chip look a label, the estimate and the date pair share: same pill, same weight —
// all facts Linear holds about the ticket.
.linear-card__label,
.linear-card__estimate,
.linear-card__dates {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.linear-card__dates {
  white-space: nowrap;
}

// Today and past-due are the only two states worth colour on a card: any other date is
// something to plan around, not a problem.
.linear-card__dates--soon {
  color: var(--k-warning);
  border-color: color-mix(in srgb, var(--k-warning) 45%, var(--k-line));
}

.linear-card__dates--overdue {
  color: var(--k-danger);
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line));
}
</style>
