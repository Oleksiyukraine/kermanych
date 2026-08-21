<template>
  <KModal
    :model-value="modelValue"
    title="Обрати директорію"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="k-dirpicker">
      <div class="k-dirpicker__cwd mono">{{ listing?.path ?? '…' }}</div>
      <p v-if="error" class="k-dirpicker__error mono" role="alert">{{ error }}</p>
      <div class="k-dirpicker__list">
        <button
          v-if="listing?.parent"
          type="button"
          class="k-dirpicker__row k-dirpicker__row--up mono"
          @click="up"
        >
          ↑ ..
        </button>
        <button
          v-for="e in listing?.entries ?? []"
          :key="e.name"
          type="button"
          class="k-dirpicker__row mono"
          @click="enter(e.name)"
        >
          <span class="k-dirpicker__name">{{ e.name }}</span>
          <span v-if="e.isRepo" class="k-dirpicker__repo" v-tip="'git-репозиторій'">⑂</span>
        </button>
        <div v-if="listing && !listing.entries.length" class="k-dirpicker__empty mono">
          (немає піддиректорій)
        </div>
      </div>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="close">Скасувати</KBtn>
      <KBtn variant="primary" :disabled="!listing" @click="choose">Обрати цю теку</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DirListing } from '@kermanych/core';
import { api } from '../../lib/api';
import KModal from './KModal.vue';
import KBtn from './KBtn.vue';

// Directory browser for the New-Project modal. Stacks over the add-group modal
// (QDialog handles the layering) and emits the chosen absolute path.
const props = withDefaults(defineProps<{ modelValue: boolean; start?: string }>(), { start: '' });
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; select: [path: string] }>();

const listing = ref<DirListing | null>(null);
const error = ref<string | null>(null);

async function load(path: string): Promise<void> {
  error.value = null;
  try {
    listing.value = await api.listDirs(path);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
function up(): void {
  if (listing.value?.parent) void load(listing.value.parent);
}
function enter(name: string): void {
  const base = listing.value?.path ?? '';
  void load(base.endsWith('/') ? base + name : `${base}/${name}`);
}
function close(): void {
  emit('update:modelValue', false);
}
function choose(): void {
  if (listing.value) emit('select', listing.value.path);
  close();
}

// Fresh load whenever opened — from the current field value, or home when empty.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      listing.value = null;
      error.value = null;
      void load(props.start ?? '');
    }
  },
);
</script>

<style scoped lang="scss">
.k-dirpicker__cwd {
  font-size: 11px;
  color: var(--k-muted);
  word-break: break-all;
  margin-bottom: 10px;
}

.k-dirpicker__error {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--k-accent);
}

.k-dirpicker__list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--k-line-strong);
}

.k-dirpicker__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--k-line);
  color: var(--k-text);
  font-size: 12.5px;
  cursor: pointer;

  &:hover {
    background: var(--k-surface2);
  }
}

.k-dirpicker__row--up {
  color: var(--k-muted);
}

.k-dirpicker__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-dirpicker__repo {
  flex: none;
  color: var(--k-accent);
}

.k-dirpicker__empty {
  padding: 12px 10px;
  font-size: 12px;
  color: var(--k-muted);
}
</style>
