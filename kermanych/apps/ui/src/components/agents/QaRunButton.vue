<template>
  <div class="qa-run">
    <!-- A tester of this session runs: the control leads to it instead of starting a second. -->
    <KBtn v-if="state.kind === 'running'" variant="secondary" :title="t('tester.run.runningTip')" @click="emit('select', state.testerId)">
      <KSpinner :size="10" />{{ t('tester.run.running') }}
    </KBtn>
    <template v-else>
      <!-- Every item passed: «Непройдені» would check nothing, so the chip is locked on «Усі». -->
      <KChipSelect
        v-if="state.kind === 'ready' && state.offerScope"
        :model-value="runScope"
        :options="scopeOptions"
        :title="t('tester.run.scopeTitle')"
        :disabled="launch.busy.value || state.allPassed"
        placement="down"
        @update:model-value="scope = $event"
      />
      <KBtn
        variant="secondary"
        class="qa-run__btn"
        :disabled="state.kind === 'refused'"
        :loading="launch.busy.value || (state.kind === 'ready' && (detailsPending || previewPending))"
        :title="hint"
        @click="onRun"
      >{{ label ?? t('tester.run.label') }}</KBtn>
      <span v-if="hint" class="qa-run__hint">{{ hint }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
// «Виконати тестування» (docs/specs/2026-11-04-qa-tester-agent.md, decisions 9, 11, 12), one control
// for the FinishSheet and the QA tab. The state comes from lib/tester.ts (core's testerRefusal, the
// same guard the api applies); the card's checklist decides whether a scope is offered, and the
// doer's `.kermanych/preview.json` whether a run may start at all
// (docs/specs/2026-11-04-session-env-and-tester-preview-gate.md, decision 3). Emits `select` with
// the tester's session id — the new one after a launch, or the running one.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { platformHasDevice, type PreviewConfigStatus, type QaRunScope, type Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useSessionBrowser } from 'stores/browser';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useTaskDetails } from '../../composables/useTaskDetails';
import { qaRunState } from '../../lib/tester';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KSpinner from 'components/kit/KSpinner.vue';

// `label`: the FinishSheet's step is already titled «Тестування», so it passes a bare «Виконати»;
// the QA tab keeps the full «Виконати тестування».
const props = defineProps<{ session: Session; label?: string }>();
const emit = defineEmits<{ select: [sessionId: string] }>();

const { t } = useI18n();
const store = useOrchestrator();
const board = useBoard();
const sessionBrowser = useSessionBrowser();

// The card's checklist (verdicts included) — held here so the control works wherever it is put.
useTaskDetails(() => props.session.taskId);
const card = computed(() => (props.session.taskId ? board.tasks.find((x) => x.id === props.session.taskId) : undefined));
// Whether verdicts exist is not known until the card's checklist is read: the button spins
// meanwhile rather than starting a run whose scope the operator could not pick.
const detailsPending = computed(() => {
  const taskId = props.session.taskId;
  if (!taskId) return false;
  return card.value ? !board.detailsLoaded(taskId) : !board.loaded;
});

// The doer's preview config, read again when its turn ends (it may have written the file) and on
// every preview change. A session the preview refuses is refused by an earlier reason: unknown.
const previewConfig = ref<PreviewConfigStatus | undefined>(undefined);
const previewPending = ref(true);
let previewSeq = 0;
async function loadPreviewConfig(): Promise<void> {
  const seq = ++previewSeq;
  let config: PreviewConfigStatus | undefined;
  try {
    config = (await store.previewInfo(props.session.id)).config;
  } catch {
    config = undefined;
  }
  if (seq !== previewSeq) return;
  previewConfig.value = config;
  previewPending.value = false;
}
watch(
  [() => props.session.id, () => props.session.status, () => store.previews[props.session.id]],
  () => void loadPreviewConfig(),
  { immediate: true },
);

const platform = computed(() => store.projects.find((p) => p.id === props.session.projectId)?.platform);
// A Mobile project runs on the doer's device (docs/specs/2026-11-04-tester-mobile-device.md):
// its preview lives in the «Пристрій» tab, and a run starts it clean (decision 6, no dialog).
const device = computed(() => platformHasDevice(platform.value));
const state = computed(() =>
  qaRunState({
    session: props.session,
    sessions: store.sessions,
    items: card.value?.qaChecklist?.items ?? [],
    platform: platform.value,
    browserHost: sessionBrowser.available,
    previewConfig: previewConfig.value?.kind,
  }),
);
const hint = computed(() => {
  const st = state.value;
  const config = previewConfig.value;
  if (st.kind === 'refused' && st.hintKey === 'tester.refusal.no-preview') {
    if (config?.kind === 'invalid')
      return t(device.value ? 'tester.refusal.previewInvalidDevice' : 'tester.refusal.previewInvalid', { error: config.error });
    return t(device.value ? 'tester.refusal.noPreviewDevice' : st.hintKey);
  }
  if (st.kind === 'refused') return t(st.hintKey);
  if (st.kind !== 'ready') return '';
  return [st.allPassed ? t('tester.run.allPassed') : '', device.value ? t('tester.run.deviceClean') : ''].filter(Boolean).join(' ');
});

// «Непройдені» is the default once verdicts exist; a first run checks everything, and so does a
// run after every item passed (the api refuses «Непройдені» with nothing in it).
const scope = ref<QaRunScope>('open');
const runScope = computed<QaRunScope>(() => {
  const st = state.value;
  return st.kind === 'ready' && st.offerScope && !st.allPassed ? scope.value : 'all';
});
const scopeOptions = computed<{ value: QaRunScope; label: string }[]>(() => [
  { value: 'open', label: t('tester.run.scope.open') },
  { value: 'all', label: t('tester.run.scope.all') },
]);

const launch = useAsyncAction(async (s: Session, chosen: QaRunScope) => {
  const child = await store.runTester(s.id, chosen);
  emit('select', child.id);
});

function onRun(): void {
  if (state.value.kind !== 'ready' || detailsPending.value || previewPending.value) return;
  void launch.run(props.session, runScope.value);
}
</script>

<style scoped lang="scss">
.qa-run {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

// One line, like the FinishSheet's other step buttons: a two-line label made the step taller and
// pushed the scope chip onto a row of its own.
.qa-run__btn {
  white-space: nowrap;
}

// The reason sits on its own line under the button, never squeezing the header beside it.
.qa-run__hint {
  flex-basis: 100%;
  max-width: 360px;
  margin-left: auto;
  text-align: right;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}
</style>
