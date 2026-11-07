<template>
  <main class="an">
    <div class="an__column">
      <header class="an__head">
        <div class="an__title">
          <span class="an__eyebrow mono">{{ t('analytics.eyebrow') }}</span>
          <h1 class="an__heading">{{ scopeName }}</h1>
        </div>
        <KChipSelect v-model="period" :options="periodOptions" :title="t('analytics.periodTitle')" placement="down" />
      </header>

      <!-- What the figures cover (decisions 6 and 7): stated beside them, never guessed into them.
           The footnote is static and always there; the rest comes with the report. -->
      <ul class="an__coverage mono">
        <template v-if="shown">
          <li v-if="importNote">{{ importNote }}</li>
          <li v-if="waitingSince">{{ t('analytics.coverage.waitingSince', { date: waitingSince }) }}</li>
          <li v-if="shown.coverage.unpricedTokens > 0">
            <!-- An abbreviated figure («87.2M») reads «87,2 млн токенів»: from 1000 up the plural
                 follows the unit word, not the last digit of the exact count. -->
            {{ t('analytics.coverage.unpriced', { tokens: tokens(shown.coverage.unpricedTokens) }, shown.coverage.unpricedTokens >= 1000 ? 5 : shown.coverage.unpricedTokens) }}
          </li>
          <li v-if="shown.coverage.sessionsWithoutHistory > 0">
            {{ t('analytics.coverage.noHistory', { n: shown.coverage.sessionsWithoutHistory }, shown.coverage.sessionsWithoutHistory) }}
          </li>
        </template>
        <li class="an__coverage-foot">{{ t('analytics.coverage.notCounted') }}</li>
      </ul>

      <!-- Not loaded for THIS scope and period: blank, then the skeleton (useLoadPhase). A failed
           first read is said inline with its retry, never left as an endless skeleton. -->
      <div v-if="failedNow" class="an__error">
        <span>{{ t('analytics.loadError', { error: failure }) }}</span>
        <KBtn :loading="retry.busy.value" @click="retry.run()">{{ t('analytics.retry') }}</KBtn>
      </div>

      <div v-else-if="phase === 'skeleton'" class="an__skeleton">
        <div class="an__tiles">
          <KSkeleton v-for="i in 6" :key="i" variant="block" width="100%" height="84px" />
        </div>
        <KSkeleton variant="block" width="100%" height="220px" />
        <KSkeleton variant="rows" :rows="4" />
      </div>

      <template v-else-if="shown">
        <div v-if="empty" class="an__blank">
          <p class="an__blank-text">{{ t('analytics.empty') }}</p>
        </div>

        <template v-else>
          <div class="an__tiles">
            <AnalyticsTile
              :label="t('analytics.tile.cost')"
              :value="money(shown.tiles.cost.value)"
              :metric="shown.tiles.cost"
              :format="money"
            />
            <AnalyticsTile
              :label="t('analytics.tile.tokens')"
              :value="tokens(shown.tiles.tokens.value)"
              :note="shown.tiles.cacheShare === null ? undefined : t('analytics.tile.cacheShare', { share: share(shown.tiles.cacheShare) })"
              :metric="shown.tiles.tokens"
              :format="tokens"
            />
            <AnalyticsTile
              :label="t('analytics.tile.working')"
              :value="time(shown.tiles.workingMs.value)"
              :note="shown.tiles.parallelism === null ? undefined : t('analytics.tile.parallelism', { x: parallelism(shown.tiles.parallelism, locale) })"
              :metric="shown.tiles.workingMs"
              :format="time"
            />
            <AnalyticsTile
              :label="t('analytics.tile.waiting')"
              :value="time(shown.tiles.waitingMs.value)"
              :note="shown.tiles.waitMedianMs === null ? undefined : t('analytics.tile.waitMedian', { time: time(shown.tiles.waitMedianMs) })"
              :metric="shown.tiles.waitingMs"
              :format="time"
            />
            <AnalyticsTile
              :label="t('analytics.tile.sessions')"
              :value="String(shown.tiles.sessions.value)"
              :metric="shown.tiles.sessions"
            />
            <AnalyticsTile
              :label="t('analytics.tile.prs')"
              :value="String(shown.tiles.prs.value)"
              :note="shown.tiles.costPerPr === null ? undefined : t('analytics.tile.costPerPr', { cost: money(shown.tiles.costPerPr) })"
              :metric="shown.tiles.prs"
            />
          </div>

          <section class="an__block">
            <header class="an__block-head">
              <h2 class="an__block-title">{{ t('analytics.dynamics.title') }}</h2>
              <KTabs :model-value="metric" :tabs="metricTabs" @update:model-value="pickMetric" />
              <KTabs :model-value="split" :tabs="splitTabs" @update:model-value="pickSplit" />
            </header>
            <AnalyticsBars
              v-if="barSeries.length"
              :buckets="shown.dynamics.buckets"
              :granularity="shown.granularity"
              :time-zone="shown.timeZone"
              :series="barSeries"
              :metric="metric"
              :format="formatMetric"
              @toggle="toggleSeries"
            />
            <p v-else class="an__muted">{{ t('analytics.dynamics.empty') }}</p>
          </section>

          <div class="an__pair">
            <section class="an__block">
              <header class="an__block-head">
                <h2 class="an__block-title">{{ t('analytics.rhythm.title') }}</h2>
              </header>
              <AnalyticsHeatmap v-if="rhythmMax(shown.rhythm) > 0" :rhythm="shown.rhythm" />
              <p v-else class="an__muted">{{ t('analytics.rhythm.empty') }}</p>
            </section>

            <section class="an__block">
              <header class="an__block-head">
                <h2 class="an__block-title">{{ t('analytics.outcomes.title') }}</h2>
                <span class="an__block-note">{{ t('analytics.outcomes.lead') }}</span>
              </header>
              <template v-if="shown.outcomes.total > 0">
                <div class="an__outbar" role="img" :aria-label="t('analytics.outcomes.aria')">
                  <span
                    v-for="o in outcomeSegments"
                    :key="o.key"
                    class="an__outbar-seg"
                    :class="`an__out--${o.key}`"
                    :style="{ flexGrow: o.count }"
                    v-tip="`${o.label}: ${o.count}`"
                  ></span>
                </div>
                <ul class="an__outlegend">
                  <li v-for="o in outcomeSegments" :key="o.key" class="an__outlegend-item">
                    <i class="an__swatch" :class="`an__out--${o.key}`" aria-hidden="true"></i>
                    <span>{{ o.label }}</span>
                    <span class="mono">{{ o.count }}</span>
                  </li>
                </ul>
                <p class="an__note mono">
                  {{ t('analytics.outcomes.count', { n: shown.outcomes.total }, shown.outcomes.total) }}
                  <template v-if="shown.outcomes.counts.pr > 0">
                    · {{ t('analytics.outcomes.reworked', { n: shown.outcomes.prReworked, total: shown.outcomes.counts.pr }) }}
                  </template>
                </p>
              </template>
              <p v-else class="an__muted">{{ t('analytics.outcomes.empty') }}</p>
            </section>
          </div>

          <section v-if="shown.models.length" class="an__block">
            <header class="an__block-head">
              <h2 class="an__block-title">{{ t('analytics.models.title') }}</h2>
            </header>
            <KTable :columns="modelColumns" :rows="shown.models" :row-key="(r: AnalyticsModelRow) => r.model">
              <template #cell-calls="{ row }"><span class="mono">{{ row.calls }}</span></template>
              <template #cell-tokens="{ row }"><span class="mono">{{ tokens(row.tokens) }}</span></template>
              <template #cell-cacheShare="{ row }">
                <span class="mono">{{ row.cacheShare === null ? '—' : share(row.cacheShare) }}</span>
              </template>
              <template #cell-cost="{ row }"><span class="mono">{{ costText(row.cost, row.costKnown) }}</span></template>
              <template #cell-costPerCall="{ row }">
                <span class="mono">{{ row.costPerCall === null ? '—' : money(row.costPerCall) }}</span>
              </template>
              <template #cell-meanModelMs="{ row }">
                <span class="mono">{{ row.meanModelMs === null ? '—' : renderTime(t, dur(row.meanModelMs)) }}</span>
              </template>
            </KTable>
          </section>

          <!-- One project in scope: its row would repeat the tiles above. -->
          <section v-if="scopeProjectCount > 1 && shown.projects.length" class="an__block">
            <header class="an__block-head">
              <h2 class="an__block-title">{{ t('analytics.projects.title') }}</h2>
            </header>
            <KTable :columns="projectColumns" :rows="shown.projects" :row-key="(r: AnalyticsProjectRow) => r.projectId">
              <template #cell-project="{ row }">{{ projectName(row.projectId) }}</template>
              <template #cell-sessions="{ row }"><span class="mono">{{ row.sessions }}</span></template>
              <template #cell-prs="{ row }"><span class="mono">{{ row.prs }}</span></template>
              <template #cell-cost="{ row }"><span class="mono">{{ money(row.cost) }}</span></template>
              <template #cell-working="{ row }"><span class="mono">{{ time(row.workingMs) }}</span></template>
              <template #cell-waiting="{ row }"><span class="mono">{{ time(row.waitingMs) }}</span></template>
            </KTable>
          </section>

          <section v-if="shown.topSessions.length" class="an__block">
            <header class="an__block-head">
              <h2 class="an__block-title">{{ t('analytics.top.title') }}</h2>
            </header>
            <KTable
              :columns="topColumns"
              :rows="shown.topSessions"
              :row-key="(r: AnalyticsTopSession) => r.sessionId"
              :row-class="(r: AnalyticsTopSession) => ({ 'an__row--gone': !r.name })"
              clickable
              @row-click="openTop"
            >
              <template #cell-session="{ row }">
                <span v-if="row.name" class="an__session" v-tip="t('analytics.top.open')">{{ row.name }}</span>
                <span v-else class="an__gone">{{ t('analytics.top.deleted') }}</span>
              </template>
              <template #cell-project="{ row }">{{ projectName(row.projectId) }}</template>
              <template #cell-class="{ row }">{{ t(`analytics.class.${row.sessionClass}`) }}</template>
              <template #cell-tokens="{ row }"><span class="mono">{{ tokens(row.tokens) }}</span></template>
              <template #cell-cost="{ row }"><span class="mono">{{ costText(row.cost, row.costKnown) }}</span></template>
            </KTable>
          </section>

          <section class="an__block">
            <header class="an__block-head">
              <h2 class="an__block-title">{{ t('analytics.minion.title') }}</h2>
            </header>
            <div class="an__pair an__pair--flat">
              <div class="an__counts">
                <h3 class="an__counts-title mono">{{ t('analytics.minion.runs') }}</h3>
                <ul v-if="minionRuns > 0" class="an__count-list">
                  <li v-for="o in MINION_OUTCOMES" :key="o" class="an__count">
                    <span>{{ t(`analytics.minion.outcome.${o}`) }}</span>
                    <span class="mono">{{ shown.minion[o] }}</span>
                  </li>
                </ul>
                <p v-else class="an__muted">{{ t('analytics.minion.none') }}</p>
              </div>
              <div class="an__counts">
                <h3 class="an__counts-title mono">{{ t('analytics.findings.title') }}</h3>
                <template v-if="findingsCount > 0">
                  <ul class="an__count-list" :aria-label="t('analytics.findings.byKind')">
                    <li v-for="k in FINDING_KINDS" :key="k" class="an__count">
                      <span>{{ t(`analytics.findings.kind.${k}`) }}</span>
                      <span class="mono">{{ shown.findings.byKind[k] }}</span>
                    </li>
                  </ul>
                  <ul class="an__count-list" :aria-label="t('analytics.findings.byStatus')">
                    <li v-for="s in FINDING_STATUSES" :key="s" class="an__count">
                      <span>{{ t(`analytics.findings.status.${s}`) }}</span>
                      <span class="mono">{{ shown.findings.byStatus[s] }}</span>
                    </li>
                  </ul>
                </template>
                <p v-else class="an__muted">{{ t('analytics.findings.none') }}</p>
              </div>
            </div>
          </section>
        </template>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
// «Аналітика» (docs/specs/2026-11-07-developer-analytics.md): the developer's own figures for
// the work run on THIS machine (decision 1), one scrollable page read top to bottom (decision 2).
//
// View state only. Every number comes from the api's `AnalyticsReport` (core analyticsReport,
// decision 9); lib/analytics.ts decides the scope, the «інші» fold, the delta and how a figure
// reads. Loading follows README «Design → Async states»: a scope or period change clears the
// report at once and drops late replies, the first read of a scope lights the top bar
// (`activity.trackLoad`), and the minute refresh while visible (lib/reconcile.ts) never does.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ANALYTICS_DEFAULT_PERIOD,
  ANALYTICS_OUTCOMES,
  ANALYTICS_SPLITS,
  FINDING_KINDS,
  FINDING_STATUSES,
  MINION_OUTCOMES,
  isAnalyticsPeriod,
  type AnalyticsModelRow,
  type AnalyticsPeriod,
  type AnalyticsProjectRow,
  type AnalyticsReport,
  type AnalyticsSplit,
  type AnalyticsTopSession,
} from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KTabs from 'components/kit/KTabs.vue';
import AnalyticsBars from 'components/analytics/AnalyticsBars.vue';
import AnalyticsHeatmap from 'components/analytics/AnalyticsHeatmap.vue';
import AnalyticsTile from 'components/analytics/AnalyticsTile.vue';
import { api } from '../lib/api';
import {
  ANALYTICS_METRICS,
  ANALYTICS_OTHERS,
  analyticsProjectIds,
  duration,
  foldSeries,
  isAnalyticsMetricKey,
  longDate,
  money,
  parallelism,
  reportIsEmpty,
  rhythmMax,
  seriesColor,
  share,
  type AnalyticsBarSeries,
  type AnalyticsMetricKey,
} from '../lib/analytics';
import { tokens } from '../lib/format';
import { persisted } from '../lib/persisted';
import { installReconcile } from '../lib/reconcile';
import { dur, renderTime } from '../lib/time';
import { errorText, useAsyncAction } from '../composables/useAsyncAction';
import { useLoadPhase } from '../composables/useLoadPhase';
import { useActivity } from '../stores/activity';
import { useAuth } from '../stores/auth';
import { useCukChat } from '../stores/cuk-chat';
import { useOrchestrator } from '../stores/orchestrator';
import { useProjects } from '../stores/projects';

const { t, locale } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
const activity = useActivity();
const auth = useAuth();
const cuk = useCukChat();

// ── Scope and period ─────────────────────────────────────────────────────────────
// Decision 4: the pick is remembered on this device, like every screen preference.
const period = persisted<AnalyticsPeriod>(
  'kermanych.analytics.period',
  ANALYTICS_DEFAULT_PERIOD,
  (raw) => (isAnalyticsPeriod(raw) ? raw : null),
  (v) => v,
);
const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  '7d': 'analytics.period.days7',
  '30d': 'analytics.period.days30',
  '90d': 'analytics.period.days90',
  '12m': 'analytics.period.months12',
};
const periodOptions = computed(() =>
  (Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((value) => ({ value, label: t(PERIOD_LABELS[value]) })),
);

// The machine's zone: day boundaries and the heat map's hours are the operator's own (decision 4).
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const scopeIds = computed(() =>
  analyticsProjectIds(
    { workspaceId: store.selectedWorkspaceId, projectId: store.selectedProjectId },
    { projects: projects.projects, listRead: projects.listRead },
    store.projectWorkspace,
    store.projects.map((p) => p.id),
  ),
);
// Which of a workspace's projects are on this machine is unknown until the socket's first
// snapshot lists the local projects; asking before would ask for none of them.
const scopeReady = computed(
  () => !!store.selectedProjectId || !store.selectedWorkspaceId || store.snapshotReceived,
);
const scopeKey = computed(() => (scopeReady.value ? `${period.value}|${scopeIds.value?.join(',') ?? '*'}` : ''));
const scopeProjectCount = computed(() => scopeIds.value?.length ?? store.projects.length);

function projectName(id: string): string {
  return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? t('analytics.removedProject');
}

// Decision 3: the header names the scope.
const scopeName = computed(() => {
  if (store.selectedProjectId) {
    const id = store.selectedProjectId;
    return projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name ?? t('analytics.scope.unknown');
  }
  if (store.selectedWorkspaceId) return projects.workspaceById.get(store.selectedWorkspaceId)?.name ?? t('analytics.scope.all');
  return t('analytics.scope.all');
});

// ── Loading ──────────────────────────────────────────────────────────────────────
const report = ref<AnalyticsReport | undefined>(undefined);
// The scope key each piece of state answers for: a reply or an error for another scope is
// someone else's, and the page must not show it as this one's.
const loadedFor = ref('');
const failedFor = ref('');
const failure = ref('');
// Orders the reads within one scope: a retry and a minute refresh may overlap, and only the
// newest may land.
let seq = 0;

async function load(bar: boolean): Promise<void> {
  const key = scopeKey.value;
  if (!key) return;
  const mine = ++seq;
  const ask = api.analytics({ period: period.value, projectIds: scopeIds.value, tz: timeZone });
  try {
    const next = await (bar ? activity.trackLoad(ask) : ask);
    if (mine !== seq || key !== scopeKey.value) return;
    report.value = next;
    loadedFor.value = key;
    failedFor.value = '';
  } catch (e) {
    if (mine !== seq || key !== scopeKey.value) return;
    // A failed refresh keeps the figures on screen (as useSubscriptionUsage does): a dropped
    // api connection is not news about the work. Only a scope with nothing shown says so.
    if (loadedFor.value === key) return;
    failure.value = errorText(e);
    failedFor.value = key;
  }
}

watch(
  scopeKey,
  async (key) => {
    report.value = undefined;
    loadedFor.value = '';
    failedFor.value = '';
    if (!key) return;
    // The local api is guarded: an unauthorised read signs the user out (stores/auth.ts).
    await auth.ready;
    if (key === scopeKey.value) await load(true);
  },
  { immediate: true },
);

const retry = useAsyncAction(() => load(false));

let stopRefresh: (() => void) | undefined;
onMounted(() => {
  // Every 60 s while the document is visible, and once on return from a long hide. Only a
  // scope that already shows figures is refreshed; a first read is still the watcher's.
  stopRefresh = installReconcile(() => {
    if (loadedFor.value && loadedFor.value === scopeKey.value) void load(false);
  });
});
onBeforeUnmount(() => stopRefresh?.());

const shown = computed(() => (loadedFor.value && loadedFor.value === scopeKey.value ? report.value : undefined));
const failedNow = computed(() => !!failedFor.value && failedFor.value === scopeKey.value);
const phase = useLoadPhase(() => !shown.value && !failedNow.value);
const empty = computed(() => !!shown.value && reportIsEmpty(shown.value));

// ── Coverage (decisions 6 and 7) ─────────────────────────────────────────────────
const importNote = computed(() => {
  const imp = shown.value?.coverage.import;
  if (!imp || imp.state === 'done') return '';
  if (imp.state === 'pending' && imp.total === 0) return t('analytics.coverage.importPending');
  return t('analytics.coverage.importing', { done: imp.done, total: imp.total }, imp.total);
});

// Waiting and queued time start with live recording; said only when that start falls inside
// what the page compares (the period and the one before it).
const waitingSince = computed(() => {
  const r = shown.value;
  const at = r?.coverage.ledgerStartedAt;
  if (!r || !at || Date.parse(at) <= Date.parse(r.previousFrom)) return '';
  return longDate(at, locale.value, r.timeZone);
});

// ── Figures ──────────────────────────────────────────────────────────────────────
function time(ms: number): string {
  return renderTime(t, duration(ms));
}

function costText(cost: number, known: boolean): string {
  if (known) return money(cost);
  return cost > 0 ? `${money(cost)} + ${t('analytics.unpriced')}` : t('analytics.unpriced');
}

// ── «Динаміка» ───────────────────────────────────────────────────────────────────
const metric = ref<AnalyticsMetricKey>('cost');
const split = ref<AnalyticsSplit>('model');
// Legend toggles, by series key. A new split brings new keys, so its toggles start over.
const hidden = ref<ReadonlySet<string>>(new Set());
watch(split, () => (hidden.value = new Set()));

const metricTabs = computed(() => ANALYTICS_METRICS.map((m) => ({ value: m, label: t(`analytics.dynamics.metric.${m}`) })));
const splitTabs = computed(() => ANALYTICS_SPLITS.map((s) => ({ value: s, label: t(`analytics.dynamics.split.${s}`) })));

function pickMetric(v: string): void {
  if (isAnalyticsMetricKey(v)) metric.value = v;
}
function pickSplit(v: string): void {
  const next = ANALYTICS_SPLITS.find((s) => s === v);
  if (next) split.value = next;
}

function seriesLabel(key: string): string {
  if (key === ANALYTICS_OTHERS) return t('analytics.others');
  if (split.value === 'project') return projectName(key);
  if (split.value === 'class') return t(`analytics.class.${key}`);
  return key;
}

const barSeries = computed<AnalyticsBarSeries[]>(() => {
  const r = shown.value;
  if (!r) return [];
  return foldSeries(r.dynamics.series[split.value], metric.value).map((s, i) => ({
    key: s.key,
    label: seriesLabel(s.key),
    color: seriesColor(s.key, i),
    values: s.values,
    off: hidden.value.has(s.key),
  }));
});

function toggleSeries(key: string): void {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
}

function formatMetric(v: number): string {
  if (metric.value === 'cost') return money(v);
  if (metric.value === 'tokens') return tokens(Math.round(v));
  return time(v);
}

// ── Результати, Посіпака, знахідки ───────────────────────────────────────────────
const outcomeSegments = computed(() => {
  const r = shown.value;
  if (!r) return [];
  return ANALYTICS_OUTCOMES.filter((o) => r.outcomes.counts[o] > 0).map((o) => ({
    key: o,
    label: t(`analytics.outcomes.label.${o}`),
    count: r.outcomes.counts[o],
  }));
});

const minionRuns = computed(() => (shown.value ? MINION_OUTCOMES.reduce((n, o) => n + shown.value!.minion[o], 0) : 0));
const findingsCount = computed(() =>
  shown.value ? FINDING_STATUSES.reduce((n, s) => n + shown.value!.findings.byStatus[s], 0) : 0,
);

// ── Tables ───────────────────────────────────────────────────────────────────────
const modelColumns = computed<KTableColumn[]>(() => [
  { key: 'model', label: t('analytics.models.model'), mono: true },
  { key: 'calls', label: t('analytics.models.calls'), align: 'right' },
  { key: 'tokens', label: t('analytics.models.tokens'), align: 'right' },
  { key: 'cacheShare', label: t('analytics.models.cacheShare'), align: 'right' },
  { key: 'cost', label: t('analytics.models.cost'), align: 'right' },
  { key: 'costPerCall', label: t('analytics.models.costPerCall'), align: 'right' },
  { key: 'meanModelMs', label: t('analytics.models.meanTime'), align: 'right' },
]);

const projectColumns = computed<KTableColumn[]>(() => [
  { key: 'project', label: t('analytics.projects.project') },
  { key: 'sessions', label: t('analytics.projects.sessions'), align: 'right' },
  { key: 'prs', label: t('analytics.projects.prs'), align: 'right' },
  { key: 'cost', label: t('analytics.projects.cost'), align: 'right' },
  { key: 'working', label: t('analytics.projects.working'), align: 'right' },
  { key: 'waiting', label: t('analytics.projects.waiting'), align: 'right' },
]);

const topColumns = computed<KTableColumn[]>(() => [
  { key: 'session', label: t('analytics.top.session') },
  { key: 'project', label: t('analytics.top.project') },
  { key: 'class', label: t('analytics.top.class') },
  { key: 'tokens', label: t('analytics.top.tokens'), align: 'right' },
  { key: 'cost', label: t('analytics.top.cost'), align: 'right' },
]);

// Decision 8.8: a row opens the session where it lives, as ЦУК's «Відкрити сесію» does. A
// deleted session has no row to open: it reads «видалена сесія» and the click does nothing.
const openSession = useAsyncAction((id: string) => cuk.openSession(id));
function openTop(row: AnalyticsTopSession): void {
  if (row.name) void openSession.run(row.sessionId);
}
</script>

<style scoped lang="scss">
.an {
  height: 100%; // the work area (MainLayout .shell__workarea), which the terminal panel shares
  min-height: 0;
  overflow-y: auto;
  background: var(--k-canvas);
}

.an__column {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--k-sp-5) var(--k-sp-5) var(--k-sp-6);
}

.an__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--k-sp-3);
  padding-bottom: var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.an__title {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  min-width: 0;
}

.an__eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.an__heading {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.an__coverage {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--k-sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.an__coverage-foot {
  color: var(--k-faint);
}

.an__error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.an__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.an__blank {
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.an__blank-text {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// Six tiles read as one row on a wide window and as two even rows of three otherwise —
// `auto-fit` left a lone tile on a second row at the usual 1280–1440 px.
.an__tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--k-sp-3);
}
@media (min-width: 1680px) {
  .an__tiles {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

.an__block {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-width: 0;
  padding: var(--k-sp-4);
  background: color-mix(in srgb, var(--k-surface) 45%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.an__block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-2) var(--k-sp-4);
}

.an__block-title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: 700;
  color: var(--k-text);
}

.an__block-note {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.an__pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: var(--k-sp-4);
}

.an__pair--flat {
  gap: var(--k-sp-5);
}

.an__muted {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.an__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

// ── Результати: one bar of the agent sessions by where they are now ──
.an__outbar {
  display: flex;
  gap: 2px;
  height: 14px;
  overflow: hidden;
  border-radius: var(--k-r-sm);
}

.an__outbar-seg {
  flex-basis: 0;
  min-width: 4px;
}

.an__outlegend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2) var(--k-sp-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.an__outlegend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);

  .mono {
    color: var(--k-text);
  }
}

.an__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

// The status hues the agent cards already use for the same states.
.an__out--pr {
  background: var(--k-success);
}

.an__out--finished {
  background: color-mix(in srgb, var(--k-success) 45%, var(--k-text));
}

.an__out--active {
  background: var(--k-accent);
}

.an__out--stopped {
  background: var(--k-muted);
}

.an__out--error {
  background: var(--k-danger);
}

.an__out--conflict {
  background: var(--k-warning);
}

// ── Посіпака і знахідки ──
.an__counts {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  min-width: 0;
}

.an__counts-title {
  margin: 0;
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.an__count-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;

  & + & {
    padding-top: var(--k-sp-2);
    border-top: var(--k-rule-thin) solid var(--k-line);
  }
}

.an__count {
  display: flex;
  justify-content: space-between;
  gap: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);

  .mono {
    color: var(--k-text);
  }
}

// ── Найдорожчі сесії ──
.an__session {
  color: var(--k-text);
}

.an__gone {
  font-style: italic;
  color: var(--k-faint);
}

// KTable is clickable as a whole; a deleted session's row opens nothing and must not look as if it did.
:deep(.an__row--gone) {
  cursor: default;
}
</style>
