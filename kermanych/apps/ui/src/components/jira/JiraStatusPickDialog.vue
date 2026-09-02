<template>
  <KModal :model-value="modelValue" :title="title" width="420px" @update:model-value="emit('update:modelValue', $event)">
    <div class="jsp">
      <p v-if="lead" class="jsp__lead">{{ lead }}</p>
      <button
        v-for="t in options"
        :key="t.id"
        class="jsp__option"
        type="button"
        :disabled="busy"
        @click="emit('pick', t)"
      >
        <span class="jsp__status">{{ t.to.name }}</span>
        <span v-if="t.name !== t.to.name" class="jsp__via mono">{{ t.name }}</span>
      </button>
      <p v-if="!options.length" class="jsp__empty mono">Jira не пропонує переходів звідси.</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ skippable ? 'Не переносити' : 'Скасувати' }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// One question, asked three ways: «в яку колонку/статус перенести тікет?» — after a drop
// on a multi-status column, after a merge, or wherever a transition needs a human choice.
// Options are TRANSITIONS, not statuses: only what Jira's workflow actually offers from
// here is offered, so a pick can never be refused for reachability.
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import type { JiraTransitionView } from '../../lib/jira-view';

defineProps<{
  modelValue: boolean;
  title: string;
  lead?: string;
  options: JiraTransitionView[];
  busy?: boolean;
  // The merge prompt may be waved off («Не переносити»); a drop-pick is cancelled.
  skippable?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; pick: [t: JiraTransitionView] }>();
</script>

<style scoped lang="scss">
.jsp {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.jsp__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.jsp__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  cursor: pointer;
  text-align: left;

  &:hover {
    border-color: var(--k-line-strong);
  }

  &:disabled {
    cursor: wait;
    color: var(--k-faint);
  }
}

.jsp__via {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jsp__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}
</style>
