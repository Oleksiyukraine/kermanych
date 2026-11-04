<template>
  <KModal :model-value="modelValue" :title="title" width="420px" :persistent="!!busy" @update:model-value="close">
    <div class="psp">
      <p v-if="lead" class="psp__lead">{{ lead }}</p>
      <!-- The options are still being asked for: rows shaped like the buttons, never the
           «no states» line, which is only true once the answer is in. -->
      <KSkeleton v-if="loading" variant="rows" :rows="3" />
      <button
        v-for="opt in loading ? [] : options"
        :key="opt.id"
        class="psp__option"
        type="button"
        :disabled="busy"
        :aria-busy="(busy && picked === opt.id) || undefined"
        @click="pick(opt)"
      >
        <span class="psp__status">{{ opt.to.name }}</span>
        <KSpinner v-if="busy && picked === opt.id" :size="12" />
      </button>
      <p v-if="!loading && !options.length" class="psp__empty mono">{{ t('plane.statusPick.empty') }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="close(false)">{{ skippable ? t('plane.statusPick.skip') : t('plane.statusPick.cancel') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// One question, asked three ways: «в який стан перенести тікет?» — from the ticket's status
// button, after a merge, or wherever a move needs a human choice. Plane has no workflow, so
// the options are simply the project's other states, shaped as Jira-style transitions; the
// «via» line Jira's pick shows (a transition named unlike its target) has no Plane meaning.
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import { ref, watch } from 'vue';
import type { PlaneTransitionView } from '../../lib/plane-view';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue: boolean;
  title: string;
  lead?: string;
  options: PlaneTransitionView[];
  busy?: boolean;
  // The options are still loading (the merge prompt asks the api after it opens).
  loading?: boolean;
  // The merge prompt may be waved off («Не переносити»); a drop-pick is cancelled.
  skippable?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; pick: [t: PlaneTransitionView] }>();

const { t } = useI18n();

// Which option the busy state belongs to, so the pick spins and its siblings only dim.
const picked = ref<string | null>(null);
watch(
  () => props.busy,
  (b) => {
    if (!b) picked.value = null;
  },
);

function pick(opt: PlaneTransitionView): void {
  if (props.busy) return;
  picked.value = opt.id;
  emit('pick', opt);
}

// Skip/Cancel/Esc wait for the pick being applied: closing mid-apply would dequeue twice.
function close(value: boolean): void {
  if (props.busy) return;
  emit('update:modelValue', value);
}
</script>

<style scoped lang="scss">
.psp {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.psp__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.psp__option {
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

.psp__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}
</style>
