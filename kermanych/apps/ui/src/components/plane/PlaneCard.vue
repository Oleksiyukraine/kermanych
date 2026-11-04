<template>
  <div
    class="plane-card"
    role="button"
    tabindex="0"
    :draggable="draggable && !pending"
    :class="{ 'plane-card--pending': pending }"
    :aria-busy="pending || undefined"
    @click="emit('click')"
    @keydown.enter="emit('click')"
    @dragstart="onDragStart"
  >
    <div class="plane-card__head">
      <span class="plane-card__key mono">{{ issue.key }}</span>
      <span
        v-if="tone"
        class="plane-card__prio"
        :class="`plane-card__prio--${tone}`"
        v-tip="t('plane.card.priorityTip', { name: t(`plane.priority.${priority}`) })"
      ></span>
      <span v-if="issue.typeName" class="plane-card__type mono">{{ issue.typeName }}</span>
      <span class="plane-card__spacer"></span>
      <KSpinner v-if="pending" :size="12" />
      <KStatusDot v-if="agentStatus" :status="agentStatus" />
      <KAvatar
        v-if="issue.assigneeName"
        :name="issue.assigneeName"
        :avatar-url="issue.assigneeAvatar"
        :hint="t('plane.card.assigneeTip', { name: issue.assigneeName })"
        :size="18"
      />
    </div>
    <div class="plane-card__summary">{{ issue.summary }}</div>
    <div v-if="issue.labels.length || issue.estimate || dates" class="plane-card__meta">
      <span v-for="label in issue.labels" :key="label" class="plane-card__label mono">{{ label }}</span>
      <span v-if="issue.estimate" class="plane-card__estimate mono" v-tip="t('plane.card.estimateTip')">{{ issue.estimate }}</span>
      <span
        v-if="dates"
        class="plane-card__dates mono"
        :class="`plane-card__dates--${dates.tone}`"
        v-tip="datesHint"
      >{{ datesText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// One mirrored Plane work item as a board card: key + priority dot (the Linear card's
// stand-in for Plane's signal bars) + type, summary, label chips, the estimate point, the
// planning dates Plane holds for the item, the first assignee's face, and — when a shadow
// task runs — the SAME status dot a native card wears, so «агент працює на цьому тікеті»
// reads identically on every board.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PlaneIssue } from '@kermanych/cloud';
import type { SessionStatus } from '@kermanych/core';
import KAvatar from 'components/kit/KAvatar.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import { dateChip, priorityTone, priorityValue, todayIso } from '../../lib/plane-view';

const props = defineProps<{
  issue: PlaneIssue;
  agentStatus?: SessionStatus | undefined;
  draggable: boolean;
  // A move sent to Plane that the mirror has not reflected yet (`issue:<key>` pending):
  // dimmed, spinning, and not draggable, so the same card cannot be dropped twice.
  pending?: boolean | undefined;
}>();

const emit = defineEmits<{ click: []; dragstart: [] }>();

const { t } = useI18n();

const priority = computed(() => priorityValue(props.issue.priority));
const tone = computed(() => priorityTone(props.issue.priority));

// `today` is read per render rather than held: a board left open past midnight must not
// keep yesterday's «прострочено» verdict.
const dates = computed(() => dateChip(props.issue, todayIso()));
const datesText = computed(() => {
  const d = dates.value;
  if (!d) return '';
  if (d.start && d.due) return `${d.start} – ${d.due}`;
  return d.due ? t('plane.card.dateBy', { due: d.due }) : t('plane.card.dateFrom', { start: d.start });
});
const datesHint = computed(() => {
  const parts: string[] = [];
  if (props.issue.startDate) parts.push(t('plane.card.start', { date: props.issue.startDate }));
  if (props.issue.dueDate) parts.push(t('plane.card.due', { date: props.issue.dueDate }));
  if (dates.value?.tone === 'overdue') parts.push(t('plane.card.overdue'));
  return parts.join(' · ');
});

function onDragStart(e: DragEvent): void {
  if (!props.draggable || props.pending) return;
  // The payload rides on the component event; dataTransfer only needs to exist for
  // Chromium to allow the drag at all.
  e.dataTransfer?.setData('text/plain', props.issue.key);
  emit('dragstart');
}
</script>

<style scoped lang="scss">
.plane-card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-3);
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 0.12s ease;

  &--pending {
    opacity: 0.55;
    cursor: progress;
  }

  &:hover {
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }
}

.plane-card__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.plane-card__key,
.plane-card__type {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  letter-spacing: 0.02em;
}

.plane-card__type {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

// Urgent is the loud one, then high/medium/low taper off; «none» carries no dot at all.
.plane-card__prio {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: var(--k-r-pill);
  background: var(--k-muted);

  &--danger { background: var(--k-danger); }
  &--warning { background: var(--k-warning); }
  &--accent { background: var(--k-accent); }
  &--faint { background: var(--k-faint); }
}

.plane-card__spacer {
  flex: 1;
}

.plane-card__summary {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.plane-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

// The chip look a label, the estimate and the date pair share: same pill, same weight —
// all facts Plane holds about the item.
.plane-card__label,
.plane-card__estimate,
.plane-card__dates {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.plane-card__dates {
  white-space: nowrap;
}

// Today and past-due are the only two states worth colour on a card: any other date is
// something to plan around, not a problem.
.plane-card__dates--soon {
  color: var(--k-warning);
  border-color: color-mix(in srgb, var(--k-warning) 45%, var(--k-line));
}

.plane-card__dates--overdue {
  color: var(--k-danger);
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line));
}
</style>
