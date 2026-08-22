<template>
  <div v-if="total" class="k-tl mono">
    <span class="k-tl__label">Todos</span>
    <span class="k-tl__count">{{ done }}/{{ total }}</span>
    <span v-if="phase" class="k-tl__sep">·</span>
    <span v-if="phase" class="k-tl__phase">{{ phase }}</span>
    <span v-if="active" class="k-tl__sep">·</span>
    <span v-if="active" class="k-tl__active">{{ active }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TodoPhase } from '@kermanych/core';

// The plan lane: one line telling the operator how far the agent's own todo list has
// got. Absent entirely while there is no list — an empty "Todos 0/0" would be noise.
const props = defineProps<{ phases?: TodoPhase[] | undefined }>();

const all = computed(() => (props.phases ?? []).flatMap((p) => p.tasks));
const total = computed(() => all.value.length);
const done = computed(() => all.value.filter((t) => t.status === 'completed').length);
const current = computed(() =>
  (props.phases ?? []).find((p) => p.tasks.some((t) => t.status === 'in_progress')),
);
const phase = computed(() => current.value?.name ?? '');
const active = computed(
  () => current.value?.tasks.find((t) => t.status === 'in_progress')?.content ?? '',
);
</script>

<style scoped lang="scss">
.k-tl {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--k-line);
  font-size: 11.5px;
  color: var(--k-muted);
  white-space: nowrap;
  overflow: hidden;
}
.k-tl__count { color: var(--k-text); }
.k-tl__active {
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
