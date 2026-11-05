<template>
  <KModal
    :model-value="modelValue"
    :title="t('settings.skillsLibrary.importTitle')"
    width="640px"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <p class="sip__lead">{{ t('settings.skillsLibrary.importLead') }}</p>
    <p class="sip__lead sip__lead--muted">{{ t('settings.skillsLibrary.importDelivery') }}</p>
    <p v-if="error" class="sip__error mono" role="alert">{{ error }}</p>

    <!-- A folder picked through «Інша тека…» comes first: it is what the operator just asked for. -->
    <section v-if="scan" class="sip__group">
      <h4 class="sip__root mono">{{ scan.path }}</h4>
      <p v-if="!scan.skills.length" class="sip__empty mono">
        {{ t('settings.skillsLibrary.importEmptyFolder') }}
      </p>
      <ul v-else class="sip__list">
        <li v-for="s in scan.skills" :key="s.dir" class="sip__row">
          <SkillImportRow :skill="s" :exists="exists(s)" :busy="pick.busyFor(s.dir)" :disabled="pick.anyBusy()" @pick="pick.run(s.dir)" />
        </li>
      </ul>
    </section>

    <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="4" />
    <template v-else-if="phase === 'ready'">
      <section v-for="root in shownRoots" :key="root.path" class="sip__group">
        <h4 class="sip__root mono">{{ root.label }}</h4>
        <p v-if="root.error" class="sip__error mono">{{ root.error }}</p>
        <ul class="sip__list">
          <li v-for="s in root.skills" :key="s.dir" class="sip__row">
            <SkillImportRow :skill="s" :exists="exists(s)" :busy="pick.busyFor(s.dir)" :disabled="pick.anyBusy()" @pick="pick.run(s.dir)" />
          </li>
        </ul>
      </section>
      <p v-if="!shownRoots.length && !error" class="sip__empty mono">{{ t('settings.skillsLibrary.importNone') }}</p>
    </template>

    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ t('settings.modal.cancel') }}</KBtn>
      <KBtn variant="ghost" :disabled="pick.anyBusy()" @click="dirOpen = true">{{ t('settings.skillsLibrary.importOther') }}</KBtn>
    </template>

    <KDirPicker v-model="dirOpen" skills :start="scan?.path ?? ''" @select="scanFolder" />
  </KModal>
</template>

<script setup lang="ts">
// The «Навички» import picker (spec: docs/specs/2026-10-22-skill-import.md). Lists the skills in
// this machine's standard home skill folders, and any folder chosen with «Інша тека…». A pick
// reads the whole SKILL.md and hands it to the library pane, which opens its own editor
// pre-filled — this component never writes.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SkillImportCandidate, SkillImportRead, SkillImportRoot, SkillImportScan } from '@kermanych/core';
import { api } from '../../lib/api';
import { errorText, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import SkillImportRow from './SkillImportRow.vue';

const props = defineProps<{
  modelValue: boolean;
  // The owner's own skill names: a candidate under one of them is marked «уже є».
  existing: readonly string[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; pick: [skill: SkillImportRead] }>();

const { t } = useI18n();

const roots = ref<SkillImportRoot[]>([]);
const scan = ref<SkillImportScan | null>(null);
const error = ref('');
const loading = ref(false);
const dirOpen = ref(false);
const phase = useLoadPhase(() => loading.value);

// A root with nothing in it is noise; one that failed to read is not.
const shownRoots = computed(() => roots.value.filter((r) => r.skills.length || r.error));

function exists(s: SkillImportCandidate): boolean {
  return props.existing.includes(s.suggestedName);
}

// Each open re-reads: the operator may have just dropped a skill into ~/.agents/skills.
let runId = 0;
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    const run = ++runId;
    scan.value = null;
    error.value = '';
    loading.value = true;
    try {
      const next = await api.skillImportRoots();
      if (run === runId) roots.value = next;
    } catch (e) {
      if (run === runId) error.value = errorText(e);
    } finally {
      if (run === runId) loading.value = false;
    }
  },
  { immediate: true },
);

async function scanFolder(path: string): Promise<void> {
  error.value = '';
  try {
    scan.value = await api.skillImportScan(path);
  } catch (e) {
    error.value = errorText(e);
  }
}

// Keyed by the skill's folder, so the pressed row spins and no second pick races the first.
const pick = useKeyedAction(
  async (dir: string) => {
    const skill = await api.skillImportRead(dir);
    emit('pick', skill);
    emit('update:modelValue', false);
  },
  { onError: (e) => (error.value = errorText(e)) },
);
</script>

<style scoped lang="scss">
.sip__lead { font-size: 13px; color: var(--k-text); margin: 0 0 6px; }
.sip__lead--muted { color: var(--k-muted); font-size: 12px; margin-bottom: 12px; }
.sip__group { margin-bottom: 14px; }
.sip__root { font-size: 11.5px; color: var(--k-muted); margin: 0 0 6px; font-weight: 400; word-break: break-all; }
.sip__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.sip__error { font-size: 11.5px; color: var(--k-accent); margin: 0 0 8px; }
.sip__empty { font-size: 12px; color: var(--k-muted); margin: 0 0 8px; }
</style>
