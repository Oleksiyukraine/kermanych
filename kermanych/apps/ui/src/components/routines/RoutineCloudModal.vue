<template>
  <KModal
    :model-value="modelValue"
    :title="t('management.routines.cloud.title')"
    width="640px"
    :persistent="saving"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="rtn-cl">
      <p class="rtn-cl__lead">{{ t('management.routines.cloud.lead') }}</p>

      <p v-if="status === null" class="rtn-cl__error">{{ t('management.routines.cloud.unavailable') }}</p>

      <template v-else-if="status">
        <!-- What is set — never a key: the function answers which ones exist. -->
        <dl class="rtn-cl__facts">
          <dt>{{ t('management.routines.cloud.anthropic') }}</dt>
          <dd :class="{ 'rtn-cl__missing': !status.anthropic }">
            {{ status.anthropic ? t('management.routines.cloud.setModel', { model: status.model ?? '—' }) : t('management.routines.cloud.notSet') }}
          </dd>
          <dt>{{ t('management.routines.cloud.github') }}</dt>
          <dd :class="{ 'rtn-cl__missing': !status.github }">
            {{ status.github ? t('management.routines.cloud.set') : t('management.routines.cloud.notSet') }}
            <ul v-if="status.repos.length" class="rtn-cl__repos">
              <li v-for="r in status.repos" :key="r.projectId" :class="{ 'rtn-cl__missing': !r.ok }">
                {{ r.projectName }}<template v-if="r.repo"> · <span class="mono">{{ r.repo }}</span></template> —
                {{ r.ok ? t('management.routines.cloud.repoOk') : r.reason }}
              </li>
            </ul>
          </dd>
          <dt>{{ t('management.routines.cloud.slack') }}</dt>
          <dd>{{ status.slack ? t('management.routines.cloud.slackBot', { team: status.slack.teamName }) : t('management.routines.cloud.notSet') }}</dd>
        </dl>

        <template v-if="status.isOwner">
          <div class="rtn-cl__row">
            <KField v-model="draft.anthropicApiKey" type="password" :label="t('management.routines.cloud.anthropicKey')" :placeholder="status.anthropic ? t('management.routines.cloud.keep') : 'sk-ant-…'" />
            <KBtn v-if="status.anthropic" variant="ghost" :disabled="saving" @click="remove('anthropicApiKey')">{{ t('management.routines.cloud.remove') }}</KBtn>
          </div>
          <KSelect
            v-if="status.models.length"
            :model-value="draft.anthropicModel || status.model || ''"
            :label="t('management.routines.cloud.model')"
            :options="status.models"
            searchable
            @update:model-value="(v: string) => (draft.anthropicModel = v)"
          />
          <div class="rtn-cl__row">
            <KField v-model="draft.githubToken" type="password" :label="t('management.routines.cloud.githubToken')" :placeholder="status.github ? t('management.routines.cloud.keep') : 'github_pat_…'" />
            <KBtn v-if="status.github" variant="ghost" :disabled="saving" @click="remove('githubToken')">{{ t('management.routines.cloud.remove') }}</KBtn>
          </div>
          <div class="rtn-cl__row">
            <KField v-model="draft.slackBotToken" type="password" :label="t('management.routines.cloud.slackToken')" :placeholder="status.slack ? t('management.routines.cloud.keep') : 'xoxb-…'" />
            <KBtn v-if="status.slack" variant="ghost" :disabled="saving" @click="remove('slackBotToken')">{{ t('management.routines.cloud.remove') }}</KBtn>
          </div>
          <ol class="rtn-cl__steps">
            <li>{{ t('management.routines.cloud.stepAnthropic') }}</li>
            <li>{{ t('management.routines.cloud.stepGithub') }}</li>
            <li>{{ t('management.routines.cloud.stepSlack') }}</li>
          </ol>
        </template>
        <p v-else class="rtn-cl__hint">{{ t('management.routines.cloud.ownerOnly') }}</p>
      </template>

      <p v-if="error" class="rtn-cl__error">{{ error }}</p>
    </div>

    <template #controls>
      <KBtn variant="ghost" :disabled="saving" @click="emit('update:modelValue', false)">{{ t('management.routines.cancel') }}</KBtn>
      <KBtn v-if="status?.isOwner" variant="primary" :loading="saving" :disabled="!changed" @click="apply(config)">
        {{ t('management.routines.cloud.save') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The workspace's cloud runner (docs/specs/2026-10-16-routines.md, «Cloud runner»): the keys a
// cloud routine runs with. The owner pastes them here; the routines-runner Edge Function checks
// each against its service and stores it where only the function can read it, and every member
// sees only which ones are set.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RoutineCloudConfig } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KBtn from 'components/kit/KBtn.vue';
import { useRoutines } from 'stores/routines';

const props = defineProps<{ modelValue: boolean; workspaceId: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const store = useRoutines();

const status = computed(() => store.cloud[props.workspaceId]);
const draft = reactive({ anthropicApiKey: '', anthropicModel: '', githubToken: '', slackBotToken: '' });
const saving = ref(false);
const error = ref('');

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    Object.assign(draft, { anthropicApiKey: '', anthropicModel: '', githubToken: '', slackBotToken: '' });
    error.value = '';
    void store.loadCloud(props.workspaceId);
  },
  { immediate: true },
);

// Only what the owner typed: an empty field keeps the stored key.
const config = computed<RoutineCloudConfig>(() => ({
  ...(draft.anthropicApiKey.trim() ? { anthropicApiKey: draft.anthropicApiKey.trim() } : {}),
  ...(draft.anthropicModel && draft.anthropicModel !== status.value?.model ? { anthropicModel: draft.anthropicModel } : {}),
  ...(draft.githubToken.trim() ? { githubToken: draft.githubToken.trim() } : {}),
  ...(draft.slackBotToken.trim() ? { slackBotToken: draft.slackBotToken.trim() } : {}),
}));
const changed = computed(() => Object.keys(config.value).length > 0);

async function apply(change: RoutineCloudConfig): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await store.configureCloud(props.workspaceId, change);
    Object.assign(draft, { anthropicApiKey: '', anthropicModel: '', githubToken: '', slackBotToken: '' });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

function remove(key: 'anthropicApiKey' | 'githubToken' | 'slackBotToken'): Promise<void> {
  return apply({ [key]: '' });
}
</script>

<style scoped lang="scss">
.rtn-cl {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rtn-cl__lead,
.rtn-cl__hint {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}

.rtn-cl__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--k-sp-2) var(--k-sp-4);
  margin: 0;

  dt {
    font-size: var(--k-fs-xs);
    color: var(--k-faint);
    padding-top: 2px;
  }

  dd {
    margin: 0;
    font-size: var(--k-fs-sm);
    color: var(--k-text);
  }
}

.rtn-cl__repos {
  margin: var(--k-sp-1) 0 0;
  padding-left: var(--k-sp-4);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rtn-cl__missing {
  color: var(--k-danger);
}

.rtn-cl__row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--k-sp-2);
  align-items: end;
}

.rtn-cl__steps {
  margin: 0;
  padding-left: var(--k-sp-4);
  font-size: var(--k-fs-xs);
  line-height: 1.55;
  color: var(--k-faint);
}

.rtn-cl__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}
</style>
