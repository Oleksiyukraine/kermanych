<template>
  <div class="capw">
    <!-- No Jira board, no capacity: Team Capacity reads Jira's estimates and worklogs, so this
         snapshot states the same gate its full screen does rather than showing an empty bar. -->
    <p v-if="jira.integration === null" class="capw__note mono">
      {{ t('management.home.capacity.gateJira') }}
      <RouterLink class="capw__link" :to="{ name: 'management-integrations' }">
        {{ t('management.home.capacity.gateOpen') }}
      </RouterLink>
    </p>
    <p v-else-if="jira.integration === undefined" class="capw__note mono">
      {{ t('management.home.capacity.loading') }}
    </p>
    <template v-else>
      <!-- The period this snapshot covers, picked on the tile itself: the whole point of the
           tile is answering «how loaded are we THIS/NEXT week» at a glance, so the selector is
           the first control, not buried on the full screen. -->
      <div class="capw__toolbar">
        <KChipSelect
          v-model="preset"
          :options="presetOptions"
          :title="t('management.home.capacity.period')"
          placement="down"
        />
        <span class="capw__range mono">{{ range.from }} — {{ range.to }}</span>
      </div>

      <div class="capw__stats">
        <article class="capw__stat">
          <span class="capw__stat-label mono">{{ t('management.capacity.stat.capacity') }}</span>
          <strong class="capw__stat-value">{{ hours(report.summary.capacitySeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="capw__stat">
          <span class="capw__stat-label mono">{{ t('management.capacity.stat.planned') }}</span>
          <strong class="capw__stat-value">{{ hours(report.summary.plannedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="capw__stat">
          <span class="capw__stat-label mono">{{ t('management.capacity.stat.logged') }}</span>
          <strong class="capw__stat-value">{{ hours(report.summary.loggedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
      </div>

      <!-- The bar: load against capacity, on the same four-step band ladder the risk matrix and
           the full capacity screen use, so «over» means the same red everywhere in Management. -->
      <div class="capw__util" :class="`capw__util--${band}`">
        <div class="capw__util-head">
          <span class="capw__util-label mono">{{ t('management.capacity.stat.utilization') }}</span>
          <span class="capw__util-pct mono">{{ percentOf(report.summary.utilization) }}</span>
        </div>
        <div class="capw__bar" role="img" :aria-label="percentOf(report.summary.utilization)">
          <span class="capw__bar-fill" :style="{ width: barWidth }"></span>
        </div>
      </div>

      <p v-if="!report.summary.loadSeconds" class="capw__empty mono">
        {{ t('management.home.capacity.empty') }}
      </p>

      <p v-if="report.overdue.length || report.unscheduled.length" class="capw__flags mono">
        {{ t('management.capacity.stat.flags', { unscheduled: report.unscheduled.length, overdue: report.overdue.length }) }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
// Team Capacity, in one tile: the workspace's Jira estimates and logged work against an
// 8 h/day baseline for a period the operator picks from this tile's own selector. Every number
// is `capacityReport` — the same arithmetic the full screen and the assistant read — so a
// figure here is a figure there. Worklogs are fetched for the selected range; issues come from
// the Jira session the home page opened.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { JiraWorklog } from '@kermanych/cloud';
import KChipSelect from 'components/kit/KChipSelect.vue';
import { useJira } from 'stores/jira';
import { useNow } from '../../composables/useNow';
import { hours } from '../../lib/format';
import {
  CAPACITY_PRESETS,
  DEFAULT_HOURS_PER_DAY,
  capacityReport,
  presetRange,
  todayIso,
  type CapacityPreset,
} from '../../lib/capacity';

defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const jira = useJira();
const nowMs = useNow(60_000);
const today = computed(() => todayIso(nowMs.value));

// The period this snapshot covers, kept on the tile. Defaults to the current week — the horizon
// a «are we over-committed right now» glance is asking about. Options are the full screen's presets.
const preset = ref<CapacityPreset>('thisWeek');
const presetOptions = computed(() =>
  CAPACITY_PRESETS.map((value) => ({ value, label: t(`management.capacity.preset.${value}`) })),
);

const range = computed(() => presetRange(preset.value, today.value));

const worklogs = ref<JiraWorklog[]>([]);
let generation = 0;

async function loadWorklogs(): Promise<void> {
  if (!jira.integration) return;
  const mine = ++generation;
  try {
    const rows = await jira.fetchWorklogs(range.value);
    if (mine === generation) worklogs.value = rows;
  } catch {
    // The plan still renders from the estimates; logged time is best-effort.
  }
}

watch(range, () => void loadWorklogs());
watch(
  () => jira.integration?.id,
  (id) => {
    if (id) void loadWorklogs();
  },
  { immediate: true },
);
// The 30 s sync tick has no worklog channel, so worklogs are re-read when a tick finishes.
watch(
  () => jira.syncing,
  (now, before) => {
    if (before && !now) void loadWorklogs();
  },
);

const report = computed(() =>
  capacityReport(jira.issues, worklogs.value, {
    range: range.value,
    today: today.value,
    hoursPerDay: DEFAULT_HOURS_PER_DAY,
  }),
);

const band = computed<'idle' | 'ok' | 'high' | 'over'>(() => {
  const u = report.value.summary.utilization;
  if (u > 1.2) return 'over';
  if (u > 1) return 'high';
  if (u >= 0.8) return 'ok';
  return 'idle';
});

function percentOf(u: number): string {
  return `${Math.round(u * 100)}%`;
}

const barWidth = computed(() => `${Math.min(100, Math.round(report.value.summary.utilization * 100))}%`);
</script>

<style scoped lang="scss">
.capw {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  height: 100%;
}

.capw__note {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
}

.capw__link {
  color: var(--k-accent);
  text-decoration: underline;
}

.capw__toolbar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  flex-wrap: wrap;
}

.capw__range {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.capw__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--k-sp-2);
}

.capw__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.capw__stat-label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.capw__stat-value {
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
  line-height: 1;
}

.capw__stat-value small {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  margin-left: 2px;
}

.capw__util {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.capw__util-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.capw__util-label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.capw__util-pct {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.capw__bar {
  height: 8px;
  background: var(--k-surface2);
  border-radius: var(--k-r-pill);
  overflow: hidden;
}

.capw__bar-fill {
  display: block;
  height: 100%;
  background: var(--k-muted);
  transition: width 0.2s;
}

.capw__util--ok .capw__bar-fill { background: var(--k-success); }
.capw__util--ok .capw__util-pct { color: var(--k-success); }
.capw__util--high .capw__bar-fill { background: var(--k-warning); }
.capw__util--high .capw__util-pct { color: var(--k-warning); }
.capw__util--over .capw__bar-fill { background: var(--k-danger); }
.capw__util--over .capw__util-pct { color: var(--k-danger); }

.capw__empty,
.capw__flags {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.capw__flags {
  color: var(--k-warning);
}
</style>
