<template>
  <section class="mn">
    <div class="mn__head">
      <p class="mn__title">{{ t('minion.panel.machineTitle') }}</p>
      <span v-if="active" class="mn__badge mn__badge--on">{{ t('minion.panel.active') }}</span>
    </div>
    <p class="mn__lead">{{ t('minion.panel.lead') }}</p>

    <!-- Activation is this machine's own fact (SQLite `minion_projects`), never the cloud's:
         another machine of the same account does not start taking cards because of it. -->
    <div class="mn__actions">
      <KBtn
        :variant="active ? 'secondary' : 'primary'"
        :loading="activation.busy.value"
        :disabled="!minion.state || (!active && !bound)"
        @click="activation.run()"
      >{{ active ? t('minion.panel.deactivate') : t('minion.panel.activate') }}</KBtn>
    </div>
    <p v-if="!active && !bound" class="mn__hint">{{ t('minion.panel.notBound') }}</p>
    <p v-else-if="active" class="mn__hint">{{ t('minion.panel.deactivateHint') }}</p>

    <!-- One cap and one pause for every active project of this machine. -->
    <p v-if="minion.loadError && !minion.state" class="mn__error mono">{{ t('minion.panel.loadFailed', { error: minion.loadError }) }}</p>
    <KSkeleton v-else-if="machinePhase === 'skeleton'" variant="lines" :rows="3" />
    <template v-else-if="machinePhase === 'ready' && minion.state">
      <div class="mn__cap">
        <KSelect
          :label="t('minion.panel.cap')"
          :model-value="cap.value.value"
          :options="capOptions"
          :loading="cap.pending.value"
          @update:model-value="cap.set($event)"
        />
        <p class="mn__hint">{{ t('minion.panel.capHint', { max: MINION_CAP_MAX }) }}</p>
      </div>

      <div class="mn__state">
        <span class="mn__state-text" :class="{ 'mn__state-text--paused': minion.state.pause }">
          {{
            minion.state.pause
              ? t('minion.panel.paused', { reason: minionPauseText(t, minion.state.pause) })
              : t('minion.panel.working', { running: minion.state.running, cap: minion.state.cap, waiting: minion.state.waiting })
          }}
        </span>
        <KBtn
          variant="secondary"
          :loading="pausing.busy.value"
          @click="pausing.run(!minion.state.pause)"
        >{{ minion.state.pause ? t('minion.strip.resume') : t('minion.strip.pause') }}</KBtn>
      </div>

      <p class="mn__caption">{{ t('minion.panel.projects') }}</p>
      <p class="mn__projects">{{ activeNames.length ? activeNames.join(', ') : t('minion.panel.noProjects') }}</p>
      <p v-if="minion.state.pollError" class="mn__error mono">{{ t('minion.panel.pollError', { error: minion.state.pollError }) }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда» → project → «Агенти» → «Посіпака»: the machine block of its page
// (docs/specs/2026-10-23-minion-auto-run.md, decisions 6 and 8; placed by
// docs/specs/2026-11-03-ai-team-agent-pages.md, decision 1). Switching it on for THIS project on
// THIS machine, and the machine's own cap, state and active projects (stores/minion, fed by the
// api's socket). What the minion is told is the page's read-only instruction block, like any agent.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MINION_CAP_MAX } from '@kermanych/core';
import { useMinion } from 'stores/minion';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { minionPauseText, minionProjectNames } from '../../lib/minion';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KSelect from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ projectId: string }>();

const { t } = useI18n();
const minion = useMinion();
const store = useOrchestrator();
const projects = useProjects();

// ── Activation ───────────────────────────────────────────────────────────
const active = computed(() => !!minion.state?.projects.includes(props.projectId));
// The api refuses `project not bound` too; this greys the button out before the refusal. A
// project already active stays deactivatable whatever its binding.
const bound = computed(() => !!store.projects.find((p) => p.id === props.projectId)?.localRepoPath);
const activation = useAsyncAction(() => minion.setProjectActive(props.projectId, !active.value));

// ── This machine ─────────────────────────────────────────────────────────
const machinePhase = useLoadPhase(() => !minion.state && !minion.loadError);
const capOptions = Array.from({ length: MINION_CAP_MAX }, (_, i) => String(i + 1));
const cap = useOptimisticValue(
  () => String(minion.state?.cap ?? ''),
  (next: string) => minion.setCap(Number(next)),
);
const pausing = useAsyncAction((paused: boolean) => minion.setPaused(paused));
const activeNames = computed(() =>
  minion.state
    ? minionProjectNames(minion.state, (id) => projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name)
    : [],
);
</script>

<style scoped lang="scss">
.mn { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.mn__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mn__title { margin: 0; font-size: 12.5px; }
.mn__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
.mn__badge--on { color: var(--k-accent); border-color: var(--k-accent); }
.mn__lead { margin: 8px 0 0; font-size: 13px; color: var(--k-muted); }
.mn__caption { margin: 12px 0 4px; font-size: 11.5px; color: var(--k-muted); }
.mn__hint { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
.mn__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
.mn__actions { display: flex; gap: 6px; margin-top: 10px; }
.mn__cap { max-width: 220px; margin-top: 14px; }
.mn__state { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mn__state-text { font-size: 12.5px; }
.mn__state-text--paused { color: var(--k-accent); }
.mn__projects { margin: 0; font-size: 12.5px; }
</style>
