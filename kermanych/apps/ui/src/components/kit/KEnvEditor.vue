<template>
  <div class="k-env">
    <p v-if="!ignored" class="k-env__warn" role="alert">
      ⚠ `.env` не в `.gitignore` — його можуть закомітити. Додай `.env` до `.gitignore`.
    </p>
    <p class="k-env__note">
      Значення зберігаються у `.env` проєкту; Керманич їх у себе не тримає. У git файл не потрапляє.
    </p>

    <div v-for="(row, i) in rows" :key="i" class="k-env__row">
      <KField v-model="row.key" placeholder="KEY" />
      <KField v-model="row.value" :type="row.reveal ? 'text' : 'password'" placeholder="value" />
      <KBtn variant="icon" title="Показати/сховати" @click="row.reveal = !row.reveal">
        {{ row.reveal ? '🙈' : '👁' }}
      </KBtn>
      <KBtn variant="icon" title="Видалити" @click="rows.splice(i, 1)">✕</KBtn>
    </div>

    <KBtn variant="secondary" @click="rows.push({ key: '', value: '', reveal: true })">
      Додати змінну
    </KBtn>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { EnvEntry } from '@kermanych/core';
import KField from './KField.vue';
import KBtn from './KBtn.vue';

type Row = { key: string; value: string; reveal: boolean };

const props = defineProps<{ entries: EnvEntry[]; ignored: boolean }>();

const rows = ref<Row[]>([]);

// Re-seed the draft whenever the loaded entries change (e.g. modal re-opened).
watch(
  () => props.entries,
  (entries) => {
    rows.value = entries.map((e) => ({ key: e.key, value: e.value, reveal: false }));
  },
  { immediate: true },
);

function collect(): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  for (const r of rows.value) {
    const key = r.key.trim();
    if (key) set[key] = r.value;
  }
  const originalKeys = props.entries.map((e) => e.key);
  const remove = originalKeys.filter((k) => !Object.hasOwn(set, k));
  return { set, remove };
}

defineExpose({ collect });
</script>

<style scoped lang="scss">
.k-env { display: flex; flex-direction: column; gap: 10px; }
.k-env__row { display: grid; grid-template-columns: 1fr 1.4fr auto auto; gap: 8px; align-items: end; }
.k-env__note { font-size: 12px; color: var(--k-muted); margin: 0; }
.k-env__warn { font-size: 12px; color: var(--k-accent); margin: 0; }
</style>
