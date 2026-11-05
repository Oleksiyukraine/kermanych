<template>
  <!-- One change an agent made to a skill (docs/specs/2026-11-04-skill-self-improvement.md,
       decisions 6 and 7), shown over the console: what changed and why, and the two ways out —
       roll it back, or (the workspace owner) share it with the team. -->
  <section class="siv" :aria-labelledby="headingId">
    <header class="siv__head">
      <button
        ref="backEl"
        class="siv__back mono"
        type="button"
        :aria-label="t('cuk.notifications.entry.close')"
        v-tip="t('cuk.notifications.entry.close')"
        @click="emit('close')"
      >←</button>
      <h2 :id="headingId" class="siv__title mono">{{ t('cuk.notifications.entry.title', { skill: entry?.skillName ?? '' }) }}</h2>
      <span v-if="entry && entry.state !== 'applied'" class="siv__state mono">{{ t(`cuk.notifications.state.${entry.state}`) }}</span>
    </header>

    <div class="siv__body">
      <template v-if="entry">
        <p class="siv__summary">{{ entry.summary }}</p>
        <p class="siv__meta mono">{{ meta }}</p>
      </template>

      <KSkeleton v-if="phase === 'skeleton'" variant="lines" :rows="6" />
      <div v-else-if="loadError" class="siv__error" role="alert">
        <p>{{ t('cuk.notifications.entry.loadFailed', { error: loadError }) }}</p>
        <KBtn variant="ghost" :loading="load.busy.value" @click="load.run()">{{ t('cuk.notifications.retry') }}</KBtn>
      </div>
      <template v-else-if="detail">
        <div class="siv__reason">
          <span class="siv__label mono">{{ t('cuk.notifications.entry.reason') }}</span>
          <p>{{ detail.record.reason }}</p>
        </div>
        <p v-if="detail.teamChanged && detail.record.state === 'applied'" class="siv__note" role="note">
          {{ t('cuk.notifications.entry.teamChanged') }}
        </p>
        <p v-if="after === undefined" class="siv__note" role="note">{{ t('cuk.notifications.entry.afterMissing') }}</p>
        <div v-else class="siv__diff">
          <KDiffRows :diff="diff" />
        </div>
      </template>
    </div>

    <footer v-if="detail && detail.record.state === 'applied'" class="siv__controls">
      <KBtn
        v-if="canShare"
        variant="ghost"
        :loading="share.busy.value"
        :disabled="rollback.busy.value"
        @click="share.run()"
      >{{ t('cuk.notifications.entry.share') }}</KBtn>
      <KBtn
        variant="secondary"
        :loading="rollback.busy.value"
        :disabled="share.busy.value"
        @click="rollback.run()"
      >{{ t('cuk.notifications.entry.rollback') }}</KBtn>
    </footer>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openId` is set. The
// record is read on open (its text is not in the list, to spare egress); rollback and sharing are
// planned first — the plan names what else goes — and run only after the confirmation.
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { shareTarget, skillImprovementAfter, skillTextDiff } from '@kermanych/core';
import { useNotificationCenter, type SkillImprovementDetail } from 'stores/notification-center';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useNow } from '../../composables/useNow';
import { confirmAction } from '../../lib/confirm';
import { relativeTime, renderTime } from '../../lib/time';
import type { FileDiff } from '../../lib/api';
import KBtn from 'components/kit/KBtn.vue';
import KDiffRows from 'components/kit/KDiffRows.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useNotificationCenter();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);
const headingId = useId();
const backEl = ref<HTMLButtonElement | null>(null);

const entry = computed(() => store.items.find((i) => i.entry.id === props.id)?.entry ?? store.details[props.id]?.record);
const detail = ref<SkillImprovementDetail | undefined>(store.details[props.id]);
const loadError = ref('');
const phase = useLoadPhase(() => !detail.value && !loadError.value);

const load = useAsyncAction(
  async () => {
    loadError.value = '';
    try {
      detail.value = await store.inspect(props.id);
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    }
  },
);

// The cached detail follows Realtime: a rollback made on another machine settles this view too.
watch(
  () => store.details[props.id],
  (d) => {
    if (d) detail.value = d;
  },
);
watch(
  () => props.id,
  () => {
    detail.value = store.details[props.id];
    void load.run();
  },
);
onMounted(() => {
  void load.run();
  void nextTick(() => backEl.value?.focus());
});

function projectName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return projects.byId.get(id)?.name ?? local.projects.find((p) => p.id === id)?.name;
}

const meta = computed(() => {
  const e = entry.value;
  if (!e) return '';
  return [
    renderTime(t, relativeTime(e.createdAt, now.value)),
    e.sessionName ? t('cuk.notifications.entry.session', { session: e.sessionName }) : '',
    projectName(e.projectId) ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
});

const after = computed(() => (detail.value ? skillImprovementAfter(detail.value.record) : undefined));
const diff = computed<FileDiff>(() => ({
  ...skillTextDiff(detail.value?.record.beforeBody ?? '', after.value ?? ''),
  binary: false,
  truncated: false,
}));

// The share goes where the skill came from; RLS lets only the workspace owner write there, so the
// button is offered to the owner alone.
const target = computed(() => (detail.value ? shareTarget(detail.value.record) : undefined));
const canShare = computed(() => {
  const to = target.value;
  if (!to) return false;
  return to.scope === 'workspace' ? projects.isWorkspaceOwner(to.id) : projects.isOwner(to.id);
});

const rollback = useAsyncAction(async () => {
  const planned = await store.planRollback(props.id);
  const { plan } = planned;
  const skill = plan.records[0]!.skillName;
  const message = [
    t('cuk.notifications.rollbackConfirm.base', { skill }),
    plan.later ? t('cuk.notifications.rollbackConfirm.later', { n: plan.later }) : '',
    plan.action.kind === 'delete-copy' ? t('cuk.notifications.rollbackConfirm.deleteCopy') : '',
    plan.action.kind === 'none' ? t('cuk.notifications.rollbackConfirm.none') : '',
    plan.handEdited ? t('cuk.notifications.rollbackConfirm.handEdited') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const ok = await confirmAction({
    title: t('cuk.notifications.rollbackConfirm.title'),
    message,
    confirmLabel: t('cuk.notifications.rollbackConfirm.confirm'),
  });
  if (!ok) return;
  await store.applyRollback(planned);
  local.notify(t('cuk.notifications.rollbackConfirm.done', { skill }), 'info');
});

const share = useAsyncAction(async () => {
  const planned = await store.planShare(props.id);
  const skill = planned.chain[0]?.skillName ?? entry.value?.skillName ?? '';
  const name =
    planned.target.scope === 'workspace'
      ? (projects.workspaceById.get(planned.target.id)?.name ?? planned.target.id)
      : (projectName(planned.target.id) ?? planned.target.id);
  const message = [
    t(`cuk.notifications.shareConfirm.${planned.target.scope}`, { skill, target: name }),
    planned.teamChanged ? t('cuk.notifications.shareConfirm.teamChanged') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const ok = await confirmAction({
    title: t('cuk.notifications.shareConfirm.title'),
    message,
    confirmLabel: t('cuk.notifications.shareConfirm.confirm'),
  });
  if (!ok) return;
  await store.applyShare(planned);
  local.notify(t('cuk.notifications.shareConfirm.done', { skill }), 'info');
});
</script>

<style scoped lang="scss">
// Opaque, over the console: the transcript under it must not show through the diff.
.siv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-pop);
  overflow: hidden;
}

.siv__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.siv__back {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-text);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--k-accent);
  }
}

.siv__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.siv__state {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.siv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  overflow: auto;
}

.siv__summary {
  margin: 0;
  font-size: var(--k-fs-md);
  line-height: 1.4;
}

.siv__meta {
  margin: -6px 0 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.siv__label {
  display: block;
  margin-bottom: 2px;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.siv__reason p {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  white-space: pre-line;
}

.siv__note {
  margin: 0;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-left: 3px solid var(--k-warning);
  border-radius: var(--k-r-sm);
  background: color-mix(in srgb, var(--k-warning) 10%, transparent);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

.siv__error p {
  margin: 0 0 var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

// KDiffRows' column heads stick to the top of whatever scrolls it: this box.
.siv__diff {
  flex: none;
  max-height: 100%;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  overflow: auto;
}

.siv__controls {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}
</style>
