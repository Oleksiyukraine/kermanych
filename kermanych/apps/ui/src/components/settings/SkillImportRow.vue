<template>
  <div class="sir" :class="{ 'sir--busy': busy }" :aria-busy="busy || undefined">
    <div class="sir__head">
      <span class="sir__name mono">{{ skill.name }}</span>
      <span v-if="exists" class="sir__badge">{{ t('settings.skillsLibrary.importExists') }}</span>
      <span class="sir__meta mono">{{ size }}</span>
      <button type="button" class="sir__btn" :disabled="disabled" @click="emit('pick')">
        <KSpinner v-if="busy" :size="10" />
        {{ t('settings.skillsLibrary.importPick') }}
      </button>
    </div>
    <p v-if="skill.description" class="sir__desc">{{ skill.description }}</p>
    <p v-if="skill.frontmatterError" class="sir__warn">{{ t('settings.skillsLibrary.importBroken') }}</p>
    <p v-if="skill.extraCount" class="sir__warn">
      {{ t('settings.skillsLibrary.importFiles', { n: skill.extraCount }) }}
    </p>
    <p class="sir__dir mono">{{ skill.dir }}</p>
  </div>
</template>

<script setup lang="ts">
// One skill found on disk, as the import picker lists it: what it is called, what it says it is
// for, what the copy will leave behind, and where it lives.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SkillImportCandidate } from '@kermanych/core';
import KSpinner from 'components/kit/KSpinner.vue';

const props = defineProps<{ skill: SkillImportCandidate; exists: boolean; busy: boolean; disabled: boolean }>();
const emit = defineEmits<{ pick: [] }>();
const { t } = useI18n();

const size = computed(() =>
  props.skill.bytes < 1024
    ? t('settings.skillSeq.bytes', { n: props.skill.bytes })
    : t('settings.skillSeq.kib', { n: (props.skill.bytes / 1024).toFixed(1) }),
);
</script>

<style scoped lang="scss">
.sir { padding: 8px 10px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.sir--busy { opacity: 0.7; }
.sir__head { display: flex; align-items: center; gap: 8px; }
.sir__name { font-size: 12.5px; }
.sir__badge { font-size: 10.5px; padding: 1px 6px; border: 1px dashed var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); }
.sir__meta { font-size: 11px; color: var(--k-faint); margin-left: auto; }
.sir__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-accent); border: 1px solid var(--k-accent); border-radius: var(--k-r); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.sir__btn:disabled { opacity: 0.45; cursor: default; }
.sir__desc { margin: 6px 0 0; font-size: 12px; }
.sir__warn { margin: 4px 0 0; font-size: 11.5px; color: var(--k-muted); }
.sir__dir { margin: 4px 0 0; font-size: 11px; color: var(--k-faint); word-break: break-all; }
</style>
