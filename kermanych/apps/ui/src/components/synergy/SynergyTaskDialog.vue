<template>
  <!-- «ЗАДАЧА →» — a «Синергія» prototype becomes a card for later or for a teammate
       (docs/specs/2026-11-09-merge-design-into-synergy.md, decisions 2–4). Nothing happens before
       «Створити»: then the branch is pushed, the card filed, and the session closed. -->
  <KModal
    :model-value="modelValue"
    :title="t('synergy.handoff.title')"
    width="720px"
    :persistent="createAction.busy.value"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="syn-task">
      <p class="syn-task__hint mono">{{ t('synergy.handoff.source', { branch: session.branch, base: base || t('synergy.handoff.defaultBase') }) }}</p>
      <KField v-model="title" :label="t('agents.docTask.taskTitle')" />
      <KSelect
        v-model="assignee"
        :label="t('agents.docTask.assignee')"
        :options="assigneeOptions"
        :placeholder="t('agents.docTask.unassigned')"
        :loading="membersLoading"
      />
      <div>
        <KField ref="descriptionField" v-model="description" :label="t('agents.docTask.description')" multiline :rows="12" @keydown="dictation.onKeydown" />
        <!-- Диктування (docs/specs/2026-11-03-voice-dictation.md). -->
        <KDictation
          class="syn-task__dictate"
          :state="dictation.state.value"
          :caption="dictation.caption.value"
          :level="dictation.level.value"
          @toggle="dictation.toggle"
        />
      </div>
      <!-- The pages the prototype touched, shot by Kermanych in the session browser (decision 3);
           each can be left out. -->
      <div class="syn-task__screens">
        <span class="syn-task__label">{{ t('synergy.handoff.screens') }}</span>
        <KSkeleton v-if="screensPhase === 'skeleton'" variant="block" height="56px" :label="t('synergy.handoff.screensWalking')" />
        <template v-else-if="screens">
          <p v-if="!screens.length" class="syn-task__hint">{{ t('synergy.handoff.screensNone') }}</p>
          <template v-else>
            <p class="syn-task__hint mono">{{ screens.map((s) => s.name).join(' · ') }}</p>
            <KAttachStrip :images="screens" @remove="(i: number) => screens?.splice(i, 1)" />
          </template>
        </template>
        <p v-if="screensError" class="syn-task__error" role="alert">{{ t('synergy.handoff.screensFailed', { error: screensError }) }}</p>
      </div>
      <p class="syn-task__hint">{{ t('synergy.handoff.closeNote') }}</p>
      <p v-if="error" class="syn-task__error" role="alert">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="createAction.busy.value" @click="emit('update:modelValue', false)">{{ t('agents.finish.close') }}</KBtn>
      <KBtn
        variant="primary"
        :loading="createAction.busy.value"
        :disabled="!title.trim() || screensLoading"
        @click="createAction.run()"
      >{{ t('synergy.handoff.create') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useBoard } from 'stores/board';
import { api } from '../../lib/api';
import { handleOf } from '../../lib/members';
import { imageToFile, type AttachedImage } from '../../lib/images';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useDictationField } from '../../composables/useDictationField';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KField from 'components/kit/KField.vue';
import KDictation from 'components/kit/KDictation.vue';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';

// `brief`: synergyBrief of the surviving requests, the text «Імплементувати» uses too. `base`: the
// branch the prototype forked from, where the card's pull request goes.
const props = defineProps<{ modelValue: boolean; session: Session; brief: string; base: string }>();
// `handedOver`: the card exists and the session is being closed (its row goes on `session_removed`).
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; handedOver: [session: Session] }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
const board = useBoard();

const title = ref('');
const assignee = ref('');
const description = ref('');
const descriptionField = ref<InstanceType<typeof KField> | null>(null);
// Диктування: the description is said rather than typed; closing the dialog drops the phrase.
const dictation = useDictationField({ el: () => descriptionField.value?.el(), value: description });
const membersLoading = ref(false);
const error = ref<string | null>(null);
// `screens` stays undefined until the walk answers, so «no screenshots» never shows while the
// pane is still walking the pages.
const screensLoading = ref(false);
const screens = ref<AttachedImage[] | undefined>(undefined);
const screensError = ref<string | null>(null);
const screensPhase = useLoadPhase(() => screensLoading.value);

const project = computed(() => projects.byId.get(props.session.projectId));
const assigneeOptions = computed<KSelectOption[]>(() =>
  (projects.members[project.value?.workspaceId ?? ''] ?? []).map((m) => ({ value: m.userId, label: handleOf(m) })),
);

// A card filed by a «Створити» whose session could not be closed: a second click closes it
// instead of filing a second card.
const filed = new Map<string, string>();

// Every open is fresh; a late reply for an earlier one is dropped.
let generation = 0;
watch(
  () => [props.modelValue, props.session.id] as const,
  ([open]) => {
    generation += 1;
    if (!open) {
      dictation.cancel();
      return;
    }
    title.value = props.session.name;
    description.value = props.brief;
    assignee.value = '';
    screens.value = undefined;
    screensError.value = null;
    error.value = null;
    const ws = project.value?.workspaceId;
    if (ws && !projects.members[ws]) {
      membersLoading.value = true;
      void projects
        .loadMembers(ws)
        .catch(() => undefined)
        .finally(() => { membersLoading.value = false; });
    }
    void loadScreens(generation, props.session.id);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation += 1;
});

async function loadScreens(gen: number, sessionId: string): Promise<void> {
  screensLoading.value = true;
  try {
    const shots = await api.synergyScreens(sessionId);
    if (gen !== generation) return;
    screens.value = shots.map((s) => ({ data: s.data, mimeType: s.mimeType, url: `data:${s.mimeType};base64,${s.data}`, name: s.page }));
  } catch (e) {
    if (gen === generation) {
      screens.value = [];
      screensError.value = errorText(e);
    }
  } finally {
    if (gen === generation) screensLoading.value = false;
  }
}

// Decision 8: push → card → close, each step leaving a state the next click can finish. A refused
// push files nothing; a failed card leaves the session; a failed close leaves the card and says
// so. The errors show in the dialog, which stays open.
const createAction = useAsyncAction(
  async () => {
    error.value = null;
    const s = props.session;
    const target = project.value;
    const name = title.value.trim();
    if (!target) throw new Error(t('agents.hints.publishFirst'));
    if (!name) return;
    // The phrase being spoken belongs to the description: it lands before the card is written.
    await dictation.beforeSubmit();
    const { branch, base } = await api.pushSynergy(s.id);
    if (!filed.has(s.id)) {
      const card = await board.createTask(
        {
          projectId: target.id,
          title: name,
          description: description.value,
          prefix: 'feature',
          worktree: true,
          synergyBranch: branch,
          ...(base ? { branch: base } : {}),
          ...(target.defaultModel ? { model: target.defaultModel } : {}),
          ...(target.defaultEffort ? { effort: target.defaultEffort } : {}),
          ...(assignee.value ? { assigneeId: assignee.value } : {}),
        },
        (screens.value ?? []).map(imageToFile),
      );
      if (!card) throw new Error(t('synergy.handoff.cardFailed'));
      filed.set(s.id, card.id);
    }
    try {
      await store.deleteSession(s.id);
    } catch (e) {
      throw new Error(t('synergy.handoff.closeFailed', { error: errorText(e) }));
    }
    filed.delete(s.id);
    emit('handedOver', s);
    emit('update:modelValue', false);
    store.notify(t('synergy.handoff.created', { title: name, branch }), 'info');
  },
  { onError: (e) => (error.value = errorText(e)) },
);
</script>

<style scoped lang="scss">
.syn-task {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.syn-task__dictate {
  margin-top: 6px;
}

.syn-task__screens {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.syn-task__label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.syn-task__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
  overflow-wrap: anywhere;
}

.syn-task__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}
</style>
