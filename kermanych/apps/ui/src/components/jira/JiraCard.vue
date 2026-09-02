<template>
  <div
    class="jira-card"
    role="button"
    tabindex="0"
    :draggable="draggable"
    @click="emit('click')"
    @keydown.enter="emit('click')"
    @dragstart="onDragStart"
  >
    <div class="jira-card__head">
      <span class="jira-card__key mono">{{ issue.key }}</span>
      <img v-if="issue.typeIcon" class="jira-card__icon" :src="issue.typeIcon" :alt="issue.typeName" v-tip="issue.typeName" />
      <img v-if="issue.priorityIcon" class="jira-card__icon" :src="issue.priorityIcon" :alt="issue.priorityName" v-tip="`Пріоритет: ${issue.priorityName}`" />
      <span class="jira-card__spacer"></span>
      <KStatusDot v-if="agentStatus" :status="agentStatus" />
      <KAvatar
        v-if="issue.assigneeName"
        :name="issue.assigneeName"
        :avatar-url="issue.assigneeAvatar"
        :hint="`Виконавець у Jira: ${issue.assigneeName}`"
        :size="18"
      />
    </div>
    <div class="jira-card__summary">{{ issue.summary }}</div>
    <div v-if="issue.labels.length" class="jira-card__labels">
      <span v-for="label in issue.labels" :key="label" class="jira-card__label mono">{{ label }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// One mirrored Jira ticket as a board card: key + type/priority marks (Jira's own icons —
// inventing local ones would break the «точна копія» promise), summary, label chips, the
// Jira assignee's face, and — when a shadow task runs — the SAME status dot a native card
// wears, so «агент працює на цьому тікеті» reads identically on both views.
import type { JiraIssue } from '@kermanych/cloud';
import type { SessionStatus } from '@kermanych/core';
import KAvatar from 'components/kit/KAvatar.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';

const props = defineProps<{
  issue: JiraIssue;
  agentStatus?: SessionStatus | undefined;
  draggable: boolean;
}>();

const emit = defineEmits<{ click: []; dragstart: [] }>();

function onDragStart(e: DragEvent): void {
  if (!props.draggable) return;
  // The payload rides on the component event; dataTransfer only needs to exist for
  // Chromium to allow the drag at all.
  e.dataTransfer?.setData('text/plain', props.issue.key);
  emit('dragstart');
}
</script>

<style scoped lang="scss">
.jira-card {
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

.jira-card__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.jira-card__key {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  letter-spacing: 0.02em;
}

.jira-card__icon {
  width: 14px;
  height: 14px;
  display: block;
}

.jira-card__spacer {
  flex: 1;
}

.jira-card__summary {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.jira-card__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.jira-card__label {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}
</style>
