<template>
  <div
    class="k-kanban-card"
    :class="{ 'k-kanban-card--pending': pending }"
    role="button"
    tabindex="0"
    :aria-busy="pending || undefined"
    @click="emit('click')"
  >
    <div class="k-kanban-card__title">
      <KStatusDot :status="status" />
      <span class="k-kanban-card__name">{{ title }}</span>
      <!-- Who owns this card, in the one spot the eye scans a Kanban column for it. Always
           rendered: a face that appears only when assigned makes «нікому» look like «не
           дочиталося», and the row would reflow as tasks get claimed. -->
      <KSkeleton v-if="assigneeLoading" variant="avatar" />
      <KAvatar
        v-else
        :name="assignee?.name ?? t('kit.kanbanCard.unassigned')"
        :avatar-url="assignee?.avatarUrl"
        :hint="assigneeHint"
        :empty="!assignee"
        :size="22"
      />
    </div>
    <div class="k-kanban-card__branch">{{ branch }}</div>
    <div class="k-kanban-card__meta">
      <!-- A teammate's ▶ on this card launches the deep analysis too, so the board says so. -->
      <KAnalysisMark v-if="deepAnalysis" />
      <!-- «Посіпака» on the author's machine may take it; when its run stopped on a choice, the
           card says so «На ревʼю», where cards wait on a person; when it found nothing to change,
           «Завершені» says so, muted. The predicates exclude each other: one mark at most. -->
      <KMinionMark v-if="autoRun" kind="allowed" />
      <KDecisionMark v-if="needsDecision" :reason="needsDecision" />
      <KNotNeededMark v-else-if="notNeeded" :reason="notNeeded" />
      <KSpinner v-if="pending" :size="10" class="k-kanban-card__pending" />
      <span class="k-kanban-card__where">{{ project }} · {{ time }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// Kanban card: a compact session tile for the board — status dot + title + assignee avatar,
// mono branch, and a "project · time" meta line (design-system Дошка section).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SessionStatus } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import KAvatar from './KAvatar.vue';
import KAnalysisMark from './KAnalysisMark.vue';
import KMinionMark from './KMinionMark.vue';
import KDecisionMark from './KDecisionMark.vue';
import KNotNeededMark from './KNotNeededMark.vue';
import KSpinner from './KSpinner.vue';
import KSkeleton from './KSkeleton.vue';

// `assignee` is the resolved person, not an id: the card cannot look one up, and the board
// already owns that resolution for its filter and its editor. `null` is «не призначено».
const props = defineProps<{
  title: string;
  branch: string;
  project: string;
  time: string;
  status: SessionStatus;
  assignee?: { name: string; avatarUrl?: string | undefined } | null;
  // A «Глибокий аналіз» card (KAnalysisMark): whoever launches it gets the interview first.
  deepAnalysis?: boolean | undefined;
  // «Дозволити автовиконання» (KMinionMark).
  autoRun?: boolean | undefined;
  // «Потрібне рішення», worded (lib/minion.ts minionReasonText); absent when nothing waits.
  needsDecision?: string | undefined;
  // «Не потрібно», the agent's evidence (lib/minion.ts cardNotNeededReason); absent otherwise.
  notNeeded?: string | undefined;
  // A move or launch of this card is waiting for its result (stores/pending): dimmed, spinning.
  pending?: boolean | undefined;
  // The roster that resolves `assignee` is not read yet: a placeholder face, never a raw id.
  assigneeLoading?: boolean | undefined;
}>();

const { t } = useI18n();

// The picture is the only thing naming the assignee on a card, so the bubble spells out the
// relation — a bare handle over a task tile could be read as its author.
const assigneeHint = computed(() =>
  props.assignee ? t('kit.kanbanCard.assignee', { name: props.assignee.name }) : t('kit.kanbanCard.noAssignee'),
);

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped lang="scss">
.k-kanban-card--pending {
  opacity: 0.6;
  cursor: progress;
}

.k-kanban-card__pending {
  color: var(--k-muted);
}

.k-kanban-card {
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

.k-kanban-card__title {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  color: var(--k-text);
}

.k-kanban-card__name {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  // Claims the row so the avatar is pinned to the right edge, and shrinks (min-width: 0)
  // rather than pushing the face out of a narrow column.
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-kanban-card__branch {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// Wraps: two marks («посіпака» with «потрібне рішення» or «не потрібно») and the project/time
// line are wider than a board column, and an unwrapped row pushes the card out of its column.
.k-kanban-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-1) var(--k-sp-2);
  min-width: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}
</style>
