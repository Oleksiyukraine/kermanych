<template>
  <!-- FINISH — retire the session: the worktree goes, the branch stays for its pull request.
       The body holds what to do before finishing, each next to its own button; the footer only
       ever closes the sheet or finishes, so «Завершити» is always in the same place. -->
  <KModal
    :model-value="modelValue"
    :title="t('agents.finish.title')"
    width="560px"
    persistent
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="finish">
      <!-- The branch being retired and how far it is from its base. -->
      <section class="finish__branch">
        <span class="finish__label">{{ t('agents.finish.branch') }}</span>
        <template v-if="info">
          <code class="finish__branch-name mono">{{ info.branch }}</code>
          <span class="finish__meta mono">
            {{ t('agents.finish.ahead', { n: info.ahead, base: info.target }, info.ahead) }}<template v-if="info.dirty">{{ t('agents.finish.aheadDirty') }}</template>
          </span>
        </template>
        <KSkeleton v-else-if="infoPhase === 'skeleton'" variant="lines" :rows="2" />
      </section>

      <!-- A tree left mid-merge: nothing else can happen until it is resolved. -->
      <section v-if="conflicts.length" class="finish__alert" role="alert">
        <p class="finish__alert-title">{{ t('agents.finish.conflictError') }}</p>
        <p class="finish__hint">{{ t('agents.finish.conflictFiles') }}</p>
        <ul class="finish__list mono">
          <li v-for="f in conflicts" :key="f">{{ f }}</li>
        </ul>
        <p class="finish__hint">{{ t('agents.finish.conflictHint') }}</p>
        <div class="finish__alert-actions">
          <KBtn :loading="resolveAction.busy.value" @click="run(resolveAction)">{{ t('agents.finish.resolveAuto') }}</KBtn>
        </div>
      </section>

      <template v-else>
        <p v-if="info && info.behind > 0" class="finish__warn">
          {{ t('agents.finish.behindInfo', { n: info.behind, base: info.target, action: hasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }, info.behind) }}
        </p>

        <!-- DOCUMENTATION POLICY — only for a project that switched it on: what the api will
             refuse PR / commit / finish over. A handoff or an API request the operator wants
             on this branch is asked for from the «Документація» tab, not here. -->
        <section v-if="info?.docsGate.enabled && docsFailures.length" class="finish__alert" role="alert">
          <p class="finish__alert-title">{{ t('agents.finish.docsMissing') }}</p>
          <ul class="finish__list">
            <li v-for="f in docsFailures" :key="f">{{ t(DOCS_FAILURE_KEYS[f]) }}</li>
          </ul>
          <p class="finish__hint">{{ t('agents.finish.docsBlocked') }}</p>
          <div class="finish__alert-actions">
            <KBtn
              :loading="docsAction.busy.value"
              :disabled="prAction.busy.value || finishAction.busy.value"
              @click="run(docsAction)"
            >{{ t('agents.finish.completeDocs') }}</KBtn>
          </div>
        </section>

        <!-- Optional steps before finishing, in the order they are usually taken. -->
        <section class="finish__steps">
          <span class="finish__label">{{ t('agents.finish.before') }}</span>
          <!-- «Виконати тестування»: the tester walks the card's QA checklist in the browser
               (docs/specs/2026-11-04-qa-tester-agent.md). Its session opens. -->
          <div v-if="liveSession" class="finish__step">
            <KIcon class="finish__step-icon" name="agentTester" />
            <div class="finish__step-text">
              <span class="finish__step-title">{{ t('agents.finish.testTitle') }}</span>
              <span class="finish__hint">{{ t('agents.finish.testHint') }}</span>
            </div>
            <QaRunButton class="finish__step-control" :session="liveSession" @select="onTester" />
          </div>
          <div class="finish__step">
            <KIcon class="finish__step-icon" :name="hasPr ? 'agentCommit' : 'agentPullRequest'" />
            <div class="finish__step-text">
              <span class="finish__step-title">{{ t('agents.finish.prTitle') }}</span>
              <span class="finish__hint">{{ hasPr ? t('agents.finish.commitHint') : t('agents.finish.prHint') }}</span>
            </div>
            <KBtn
              class="finish__step-btn"
              :loading="prAction.busy.value"
              :disabled="finishAction.busy.value || docsAction.busy.value || !info || !!docsFailures.length"
              @click="run(prAction)"
            >{{ hasPr ? t('agents.finish.commit') : t('agents.finish.createPr') }}</KBtn>
          </div>
        </section>
      </template>

      <p v-if="error" class="finish__error" role="alert">{{ error }}</p>
    </div>
    <template #controls>
      <span class="finish__note">{{ t('agents.finish.retireNote') }}</span>
      <KBtn variant="ghost" @click="emit('update:modelValue', false)">{{ t('agents.finish.close') }}</KBtn>
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
// documentation gate's failures — each block with the action that answers it (resolve, complete
// the docs), then the optional steps before finishing («Виконати тестування», «Створити ПР» /
// «Закоміти»). The footer is only «Закрити» and «Завершити». The parent opens it with a session;
// the sheet reads finishInfo itself and closes on success. Errors stay inside it (README → Async
// states).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DocsGateFailure, Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIcon from 'components/kit/KIcon.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import QaRunButton from './QaRunButton.vue';

const props = defineProps<{ modelValue: boolean; session: Session | null }>();
// `focus`: an action left an agent working — on the session (resolve, PR, commit, docs) or in the
// tester it started — the parent shows that session, so the operator watches the turn in its log.
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; focus: [sessionId: string] }>();

const { t } = useI18n();
const store = useOrchestrator();

const info = ref<Awaited<ReturnType<typeof store.finishInfo>> | null>(null);
const error = ref<string | null>(null);
// The branch summary is a skeleton until finishInfo answers; a failed read shows its error instead.
const infoPhase = useLoadPhase(() => props.modelValue && !info.value && !error.value);

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

// The session as the store holds it now, not as it was when ✓ was pressed: whether the agent is
// mid-turn or a tester runs decides the testing button's state.
const liveSession = computed(() => (props.session ? (store.sessions.find((x) => x.id === props.session!.id) ?? props.session) : null));

// A tester started (or the running one): show its session, where the run is watched.
function onTester(testerId: string): void {
  close();
  emit('focus', testerId);
}

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
  gap: var(--k-sp-4);
}

// Small uppercase caption over a block («Гілка», «Перед завершенням»).
.finish__label {
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.finish__branch {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-3) var(--k-sp-4);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.finish__branch-name {
  font-size: var(--k-fs-base);
  color: var(--k-text);
  overflow-wrap: anywhere;
}

.finish__meta {
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-muted);
}

.finish__warn {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-warning);
}

// A blocker (conflicts, missing documentation): the reason, the details and the action that
// answers it, in one accent-ruled block.
.finish__alert {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3) var(--k-sp-4);
  border: var(--k-rule-thin) solid var(--k-line);
  border-left: var(--k-rule-strong) solid var(--k-accent);
  border-radius: var(--k-r);
}

.finish__alert-title {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
}

.finish__alert-actions {
  display: flex;
  justify-content: flex-end;
}

.finish__steps {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

// One optional step: its mark, what it does, and its button on the right.
.finish__step {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3) var(--k-sp-4);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.finish__step-icon {
  --k-icon-size: var(--k-icon-md);
  margin-top: 2px;
  color: var(--k-muted);
}

.finish__step-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.finish__step-title {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-semibold);
  line-height: 1.4;
  color: var(--k-text);
}

// The testing control wraps its scope chip and refusal reason inside this width, so the
// description beside it keeps room.
.finish__step-control {
  flex: 0 1 auto;
  max-width: 240px;
}

// A plain step button keeps its label on one line.
.finish__step-btn {
  flex: none;
  white-space: nowrap;
}

.finish__hint {
  margin: 0;
  font-size: var(--k-fs-xs);
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
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
}

// What «Завершити» does, beside it in the footer; pushes the two buttons right.
.finish__note {
  margin-right: auto;
  align-self: center;
  font-size: var(--k-fs-xs);
  line-height: 1.4;
  color: var(--k-muted);
}
</style>
