<template>
  <KModal :model-value="modelValue" :title="title" width="420px" @update:model-value="emit('update:modelValue', $event)">
    <div class="lsp">
      <p v-if="lead" class="lsp__lead">{{ lead }}</p>
      <button
        v-for="opt in options"
        :key="opt.id"
        class="lsp__option"
        type="button"
        :disabled="busy"
        @click="emit('pick', opt)"
      >
        <span class="lsp__status">{{ opt.to.name }}</span>
        <span v-if="opt.name !== opt.to.name" class="lsp__via mono">{{ opt.name }}</span>
      </button>
      <p v-if="!options.length" class="lsp__empty mono">{{ t('linear.statusPick.empty') }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ skippable ? t('linear.statusPick.skip') : t('linear.statusPick.cancel') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// One question, asked three ways: «в яку колонку/статус перенести тікет?» — after a drop
// on a column, after a merge, or wherever a transition needs a human choice. Options are
// the team's workflow states reachable from here, so a pick can never be refused.
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import type { LinearTransitionView } from '../../lib/linear-view';
import { useI18n } from 'vue-i18n';

defineProps<{
  modelValue: boolean;
  title: string;
  lead?: string;
  options: LinearTransitionView[];
  busy?: boolean;
  // The merge prompt may be waved off («Не переносити»); a drop-pick is cancelled.
  skippable?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; pick: [t: LinearTransitionView] }>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.lsp {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.lsp__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.lsp__option {
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

.lsp__via {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.lsp__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}
</style>
