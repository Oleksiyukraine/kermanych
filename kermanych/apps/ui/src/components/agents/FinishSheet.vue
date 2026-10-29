<template>
  <!-- FINISH — retire the session: the worktree goes, the branch stays for its pull request -->
  <KModal :model-value="modelValue" :title="t('agents.finish.title')" persistent @update:model-value="emit('update:modelValue', $event)">
    <div class="finish">
      <div v-show="conflicts.length">
        <p class="finish__error" role="alert">
          {{ t('agents.finish.conflictError') }}
        </p>
        <p class="finish__hint mono">{{ t('agents.finish.conflictFiles') }}</p>
        <ul class="finish__list mono">
          <li v-for="f in conflicts" :key="f">{{ f }}</li>
        </ul>
        <p class="finish__hint mono">
          {{ t('agents.finish.conflictHint') }}
        </p>
      </div>
      <div v-show="!conflicts.length">
        <p v-if="info">
          {{ t('agents.finish.action') }} <code class="mono">{{ info.branch }}</code>
        </p>
        <p v-if="info" class="finish__hint mono">
          {{ t('agents.finish.aheadInfo', { n: info.ahead, base: info.target, dirty: info.dirty ? t('agents.finish.aheadDirty') : '' }, info.ahead) }}
        </p>
        <p v-else class="finish__hint mono">{{ t('agents.changes.preparing') }}</p>
        <p v-if="info && info.behind > 0" class="finish__hint">
          {{ t('agents.finish.behindInfo', { n: info.behind, base: info.target, action: hasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }, info.behind) }}
        </p>
        <!-- DOCUMENTATION POLICY — only for a project that switched it on: what the api will
             refuse PR / commit / finish over. A handoff or an API request the operator wants
             on this branch is asked for from the «Документація» tab, not here. -->
        <template v-if="info?.docsGate.enabled">
          <template v-if="docsFailures.length">
            <p class="finish__error" role="alert">{{ t('agents.finish.docsMissing') }}</p>
            <ul class="finish__list">
              <li v-for="f in docsFailures" :key="f">{{ t(DOCS_FAILURE_KEYS[f]) }}</li>
            </ul>
            <p class="finish__hint mono">{{ t('agents.finish.docsBlocked') }}</p>
          </template>
        </template>
      </div>
      <p v-if="error" class="finish__error" role="alert">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ t('agents.finish.close') }}</KBtn>
      <KBtn v-show="conflicts.length" variant="secondary" :loading="resolveAction.busy.value" @click="run(resolveAction)">{{ t('agents.finish.resolveAuto') }}</KBtn>
      <KBtn
        v-if="!conflicts.length && docsFailures.length"
        variant="secondary"
        :loading="docsAction.busy.value"
        :disabled="prAction.busy.value || finishAction.busy.value"
        @click="run(docsAction)"
      >{{ t('agents.finish.completeDocs') }}</KBtn>
      <KBtn
        v-show="!conflicts.length"
        variant="secondary"
        :loading="prAction.busy.value"
        :disabled="finishAction.busy.value || docsAction.busy.value || !info || !!docsFailures.length"
        @click="run(prAction)"
      >{{ hasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }}</KBtn>
      <KBtn
        variant="primary"
        :loading="finishAction.busy.value"
        :disabled="prAction.busy.value || docsAction.busy.value || !!conflicts.length || !info || !!docsFailures.length"
        @click="run(finishAction)"
      >{{ t('agents.finish.action') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// «Завершити»'s sheet, shared by Агенти and Дизайн: what retiring the session would do (the
// branch, how far it is ahead of / behind its base), a tree left mid-merge, and the
// documentation gate's failures — with the actions that answer each (resolve, complete the
// docs, «Створити ПР» / «Закоміти», «Завершити»). The parent opens it with a session; the sheet
// reads finishInfo itself and closes on success. Errors stay inside it (README → Async states).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DocsGateFailure, Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';

const props = defineProps<{ modelValue: boolean; session: Session | null }>();
// `focus`: an action left the agent working on the session (resolve, PR, commit, docs) — the
// parent shows it, so the operator watches that turn in its log.
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; focus: [sessionId: string] }>();

const { t } = useI18n();
const store = useOrchestrator();

const info = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const error = ref<string | null>(null);

const DOCS_FAILURE_KEYS: Record<DocsGateFailure, string> = {
  'task-spec': 'agents.finish.docsFailure.taskSpec',
  plan: 'agents.finish.docsFailure.plan',
  'docs-impact': 'agents.finish.docsFailure.docsImpact',
  handoff: 'agents.finish.docsFailure.handoff',
  'api-request': 'agents.finish.docsFailure.apiRequest',
  'design-readme': 'agents.finish.docsFailure.designReadme',
};
// Documentation policy (project setting): the gate's failures, as the api reported them.
const docsFailures = computed<DocsGateFailure[]>(() => info.value?.docsGate.failures ?? []);
// Files still to resolve in the worktree: a tree left mid-merge (the agent folded the base
// in) cannot be retired, so the sheet shows them instead of the finish summary.
const conflicts = computed(() => info.value?.conflicts ?? []);

// A session whose branch already has an open PR: its secondary finish action is «Закоміти»
// (land follow-up work onto that PR), never «Створити ПР» (which would try to open a second
// one and find nothing to push). Keyed off the DURABLE `prOpened`, not the transient
// `in_review` status — the operator keeps prompting the agent after «Створити ПР», which
// drives the card back through thinking/tool and would otherwise flip the button back.
const hasPr = computed(() => props.session?.prOpened === true || props.session?.status === 'in_review');

// Every open starts clean and reads the branch afresh. A reply for a session the sheet was
// reopened on since is dropped.
watch(
  () => (props.modelValue ? props.session?.id : undefined),
  async (id) => {
    if (!id) return;
    info.value = null;
    error.value = null;
    try {
      const res = await store.finishInfo(id);
      if (props.session?.id === id) info.value = res;
    } catch (e) {
      if (props.session?.id === id) error.value = errorText(e);
    }
  },
  { immediate: true },
);

const onError = (e: unknown): void => {
  error.value = errorText(e);
};
function close(): void {
  emit('update:modelValue', false);
}

// The agent resolves in the background — watch it on the card.
const resolveAction = useAsyncAction(async (s: Session) => {
  await store.resolveConflict(s.id);
  close();
  emit('focus', s.id);
}, { onError });

const finishAction = useAsyncAction(async (s: Session) => {
  await store.finishSession(s.id);
  close();
}, { onError });

// The agent pushes + opens the PR (or commits + pushes to the open one) in the background —
// watch it in the log.
const prAction = useAsyncAction(async (s: Session) => {
  if (hasPr.value) {
    await store.commitChanges(s.id);
    store.notify(t('agents.notify.committing', { name: s.name }), 'info');
  } else {
    await store.createPr(s.id);
    store.notify(t('agents.notify.prCreating', { name: s.name }), 'info');
  }
  close();
  emit('focus', s.id);
}, { onError });

// «Доповнити документацію»: the api sends the agent one prompt listing exactly the missing
// documents (with the project's task-spec / frontend-handoff skills inlined), so the sheet
// closes and the work is watched in the transcript, like «Створити ПР». `sent: false` means the
// gate passed in the meantime — nothing was asked of the agent.
const docsAction = useAsyncAction(async (s: Session) => {
  const res = await store.completeDocs(s.id);
  close();
  emit('focus', s.id);
  store.notify(t(res.sent ? 'agents.notify.docsCompleting' : 'agents.notify.docsComplete', { name: s.name }), 'info');
}, { onError });

function run(action: { run: (s: Session) => Promise<unknown> }): void {
  const s = props.session;
  if (!s) return;
  error.value = null;
  void action.run(s);
}
</script>

<style scoped lang="scss">
.finish {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.finish__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

.finish__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.finish__list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--k-accent);
}
</style>
