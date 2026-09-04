<template>
  <section class="cap">
    <p class="cap__lead">
      {{ t('management.capacity.leadBefore') }}
      <span class="cap__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.capacity.leadAfter', { hours: DEFAULT_HOURS_PER_DAY }) }}
    </p>

    <!-- The «regular board only» state, stated rather than hidden: the section exists in
         the rail for every workspace, and an empty pane under a finished nav reads as a bug. -->
    <div v-if="jira.integration === null" class="cap__gate">
      <span class="cap__gate-title mono">{{ t('management.capacity.gateTitle') }}</span>
      <p class="cap__gate-text">{{ t('management.capacity.gateText') }}</p>
      <KBtn variant="primary" @click="router.push({ name: 'management-integrations' })">
        {{ t('management.capacity.gateButton') }}
      </KBtn>
    </div>

    <p v-else-if="jira.integration === undefined || (jira.loading && !jira.issues.length)" class="cap__note mono">
      {{ t('management.capacity.loading') }}
    </p>

    <template v-else>
      <div class="cap__toolbar">
        <KDateField
          :model-value="from"
          :label="t('management.capacity.from')"
          :now-ms="nowMs"
          @update:model-value="(v: string) => editDate('from', v)"
        />
        <KDateField
          :model-value="to"
          :label="t('management.capacity.to')"
          :now-ms="nowMs"
          @update:model-value="(v: string) => editDate('to', v)"
        />
        <KChipSelect v-model="presetModel" :options="presetOptions" :title="t('management.capacity.from')" />
        <KSelect v-model="person" :options="personOptions" />
        <KTabs v-model="granularityModel" :tabs="granularityTabs" />
        <KTabs v-model="view" :tabs="viewTabs" />
      </div>

      <p v-if="jira.loadError" class="cap__error">{{ t('management.capacity.loadError', { error: jira.loadError }) }}</p>

      <div class="cap__stats">
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.capacity') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.capacitySeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.planned') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.plannedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.logged') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.loggedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat" :class="`cap__stat--${bandOf(report.summary.utilization)}`">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.utilization') }}</span>
          <strong class="cap__stat-value">{{ percentOf(report.summary.utilization) }}</strong>
        </article>
        <button
          type="button"
          class="cap__stat cap__stat--button"
          :class="{ 'cap__stat--warn': report.unscheduled.length || report.overdue.length, 'cap__stat--active': flaggedOnly }"
          v-tip="t('management.capacity.stat.flagsHint')"
          @click="toggleFlagged"
        >
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.flags', { unscheduled: report.unscheduled.length, overdue: report.overdue.length }) }}</span>
          <span class="cap__stat-note">{{ flaggedOnly ? t('management.capacity.showAll') : t('management.capacity.showFlagged') }}</span>
        </button>
      </div>

      <div v-if="!report.summary.loadSeconds && !flaggedOnly" class="cap__blank">
        <p class="cap__blank-text">{{ t('management.capacity.empty') }}</p>
        <p v-if="report.unscheduled.length" class="cap__blank-hint mono">
          {{ t('management.capacity.emptyHint', { count: report.unscheduled.length }) }}
        </p>
      </div>

      <CapacityChart v-else-if="view === 'chart' && !flaggedOnly" :report="report" @pick="pickPerson" />

      <div v-else-if="teamTable" class="cap__table-wrap">
        <KTable :columns="teamColumns" :rows="teamRows" :row-key="(r: TeamRow) => r.id" clickable @row-click="(r: TeamRow) => pickPerson(r.id)">
          <template #cell-person="{ row }">
            <span :class="{ 'cap__dash': row.id === UNASSIGNED, 'cap__strong': row.id === TEAM }">{{ row.name }}</span>
          </template>
          <template v-for="(p, i) in report.periods" :key="p.key" #[`cell-p${i}`]="{ row }">
            <span class="cap__cell mono" :class="`cap__cell--${bandOf(row.cells[i]!.utilization)}`" v-tip="cellTip(row, i)">
              {{ hours(row.cells[i]!.loadSeconds) }}<span class="cap__cell-cap">/{{ hours(row.cells[i]!.capacitySeconds) }}</span>
            </span>
          </template>
          <template #cell-total="{ row }">
            <span class="mono">{{ hours(row.total.loadSeconds) }}/{{ hours(row.total.capacitySeconds) }}</span>
          </template>
          <template #cell-util="{ row }">
            <span class="cap__cell mono" :class="`cap__cell--${bandOf(row.total.utilization)}`">{{ percentOf(row.total.utilization) }}</span>
          </template>
          <template #cell-open="{ row }">
            <span class="mono">{{ row.open }}</span>
          </template>
        </KTable>
      </div>

      <div v-else class="cap__table-wrap">
        <KTable :columns="issueColumns" :rows="issueRows" :row-key="(r: CapacityIssueRow) => r.key">
          <template #cell-key="{ row }">
            <a class="cap__key mono" :href="issueUrl(row.key)" target="_blank" rel="noopener">{{ row.key }}</a>
          </template>
          <template #cell-person="{ row }">
            <span :class="{ 'cap__dash': row.person.id === UNASSIGNED }">{{ personName(row.person) }}</span>
          </template>
          <template #cell-status="{ row }">
            <KTag plain>{{ row.statusName }}</KTag>
          </template>
          <template #cell-start="{ row }">
            <span class="mono" :class="{ 'cap__dash': !row.startDate }">{{ row.startDate ? formatIsoDate(row.startDate) : '—' }}</span>
          </template>
          <template #cell-due="{ row }">
            <span class="mono" :class="{ 'cap__dash': !row.dueDate, 'cap__overdue': row.flag === 'overdue' }">{{ row.dueDate ? formatIsoDate(row.dueDate) : '—' }}</span>
          </template>
          <template #cell-remaining="{ row }">
            <span class="mono">{{ hours(row.remainingSeconds) }}{{ t('management.capacity.h') }}</span>
          </template>
          <template #cell-inRange="{ row }">
            <span class="mono">{{ hours(row.inRangeSeconds) }}{{ t('management.capacity.h') }}</span>
          </template>
          <template #cell-flag="{ row }">
            <KTag v-if="row.flag" :class="`cap__flag cap__flag--${row.flag}`">{{ t(`management.capacity.flag.${row.flag}`) }}</KTag>
          </template>
        </KTable>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
// Team Capacity — Jira's estimates and worklogs against an 8 h/day baseline, for a date range
// the operator picks. The shell (ManagementPage) renders the heading and the workspace gate;
// this component assumes a workspace and adds one gate of its own: a Jira board, because the
// native board has no estimates and capacity without estimates is a blank chart.
//
// View state only. Every number comes from lib/capacity.ts `capacityReport`, which is also
// what the Менеджмент assistant is handed — so a figure quoted in the chat is a figure on
// this screen.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { JiraWorklog } from '@kermanych/cloud';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KTabs from 'components/kit/KTabs.vue';
import KTag from 'components/kit/KTag.vue';
import CapacityChart from 'components/capacity/CapacityChart.vue';
import { useJira } from 'stores/jira';
import { useNow } from '../composables/useNow';
import { formatIsoDate } from '../lib/calendar';
import { hours } from '../lib/format';
import { UNASSIGNED } from '../lib/jira-view';
import {
  CAPACITY_PRESETS,
  DEFAULT_HOURS_PER_DAY,
  capacityReport,
  defaultGranularity,
  normalizeRange,
  presetRange,
  sumCells,
  todayIso,
  type CapacityCell,
  type CapacityGranularity,
  type CapacityIssueRow,
  type CapacityPerson,
  type CapacityPreset,
  type CapacityRange,
} from '../lib/capacity';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const { t } = useI18n();
const router = useRouter();
const jira = useJira();
// The report is anchored on today; a minute's tick is enough for a screen measured in days.
const nowMs = useNow(60_000);
const today = computed(() => todayIso(nowMs.value));

const TEAM = '@team';
const ALL = '';
// The chip's own «no preset» option: KChipSelect falls back to the raw model value when it
// finds no matching option, which rendered blank the moment a date edit cleared `preset`.
const CUSTOM = 'custom';

// ── range ─────────────────────────────────────────────────────────────────────

// Remembered per workspace, like the board's view switch: a manager who looks at «next two
// weeks» every Monday should not have to pick it every Monday.
type Saved = { from: string; to: string; preset: CapacityPreset | ''; granularity: CapacityGranularity | '' };
const storageKey = () => `capacity:${props.workspaceId}`;
function readSaved(): Saved | undefined {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}

const preset = ref<CapacityPreset | ''>('next2Weeks');
const from = ref('');
const to = ref('');
// '' = follow the range length (defaultGranularity); set once the operator chose.
const granularityChoice = ref<CapacityGranularity | ''>('');

function applyPreset(p: CapacityPreset): void {
  const r = presetRange(p, today.value);
  from.value = r.from;
  to.value = r.to;
  preset.value = p;
  granularityChoice.value = '';
}

// A typed or picked date is the operator's intent: it ends the preset and releases the
// Days/Weeks override, which is what «until the range changes» means. applyPreset and the
// saved-range restore set the refs directly and keep their own state.
function editDate(which: 'from' | 'to', value: string): void {
  if (which === 'from') from.value = value;
  else to.value = value;
  preset.value = '';
  granularityChoice.value = '';
}

// KChipSelect is generic over its option type; the model is a plain string. '' (no preset,
// i.e. a custom range) reads as the CUSTOM option rather than falling back to the raw '',
// which KChipSelect cannot label.
const presetModel = computed({
  get: () => preset.value || CUSTOM,
  set: (v: string) => {
    // Picking CUSTOM is a no-op: it only names the state the operator is already in.
    if (v !== CUSTOM && (CAPACITY_PRESETS as readonly string[]).includes(v)) applyPreset(v as CapacityPreset);
  },
});
const presetOptions = computed(() => [
  ...CAPACITY_PRESETS.map((value) => ({ value: value as string, label: t(`management.capacity.preset.${value}`) })),
  { value: CUSTOM, label: t('management.capacity.preset.custom') },
]);

const range = computed<CapacityRange | undefined>(() =>
  from.value && to.value ? normalizeRange({ from: from.value, to: to.value }) : undefined,
);

const granularityModel = computed({
  get: () => granularityChoice.value || (range.value ? defaultGranularity(range.value) : 'day'),
  set: (v: string) => {
    granularityChoice.value = v as CapacityGranularity;
  },
});
const granularityTabs = computed(() => [
  { value: 'day', label: t('management.capacity.granularity.day') },
  { value: 'week', label: t('management.capacity.granularity.week') },
]);

watch([from, to, preset, granularityChoice], () => {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ from: from.value, to: to.value, preset: preset.value, granularity: granularityChoice.value } satisfies Saved));
  } catch {
    /* private mode: the preference just does not stick */
  }
});

// ── person / view ─────────────────────────────────────────────────────────────

const person = ref(ALL);
// A string, not a union: KTabs emits `string`, and a narrower ref fails vue-tsc on v-model.
const view = ref<string>('chart');
const viewTabs = computed(() => [
  { value: 'chart', label: t('management.capacity.view.chart') },
  { value: 'table', label: t('management.capacity.view.table') },
]);
const flaggedOnly = ref(false);

function toggleFlagged(): void {
  flaggedOnly.value = !flaggedOnly.value;
  if (flaggedOnly.value) view.value = 'table';
}

function pickPerson(id: string): void {
  if (id === TEAM) return;
  person.value = person.value === id ? ALL : id;
}

// ── data ──────────────────────────────────────────────────────────────────────

const worklogs = ref<JiraWorklog[]>([]);
let worklogGeneration = 0;

async function loadWorklogs(): Promise<void> {
  const r = range.value;
  if (!r || !jira.integration) return;
  const mine = ++worklogGeneration;
  try {
    const rows = await jira.fetchWorklogs(r);
    if (mine === worklogGeneration) worklogs.value = rows;
  } catch {
    // The chart still shows the plan; logged time is best-effort until the next tick.
  }
}

// Token for the session THIS page opened — see stores/jira.ts. Kept so the unmount below
// closes only its own session, never one an arriving view (the board, or another workspace's
// Team Capacity) has since opened.
let openToken: number | undefined;

async function enter(id: string): Promise<void> {
  person.value = ALL;
  flaggedOnly.value = false;
  const saved = readSaved();
  // A remembered PRESET is re-resolved against today — «next 2 weeks» saved last Monday
  // means this coming fortnight, not last week's. Only custom dates are kept verbatim. The
  // shape is validated: a hand-edited or future-format blob must not reach presetRange with
  // a preset it does not recognize.
  if (saved?.preset && (CAPACITY_PRESETS as readonly string[]).includes(saved.preset)) applyPreset(saved.preset);
  else if (saved?.from && saved.to) {
    from.value = saved.from;
    to.value = saved.to;
    preset.value = '';
  } else applyPreset('next2Weeks');
  if (saved?.granularity === 'day' || saved?.granularity === 'week') granularityChoice.value = saved.granularity;
  openToken = await jira.open(id);
  void loadWorklogs();
}

// The first open runs post-mount rather than in an `immediate` watcher: Vue flushes a
// leaving view's onUnmounted AFTER an entering view's setup, so an immediate open() here
// would have its generation bumped moments later by the board's own close() (both views
// share the one useJira() session) and probe() would bail. Mounting is already after that
// flush, so this open sees a settled store.
onMounted(() => {
  if (props.workspaceId) void enter(props.workspaceId);
});
watch(
  () => props.workspaceId,
  (id) => {
    if (id) void enter(id);
  },
);

watch(range, () => void loadWorklogs());
// The sync tick refreshes issues through realtime; worklogs have no channel, so they are
// re-read when a tick finishes.
watch(
  () => jira.syncing,
  (now, before) => {
    if (before && !now) void loadWorklogs();
  },
);

onUnmounted(() => jira.close(openToken));

// The unfiltered report feeds the person picker, so the list does not shrink to the one
// person picked.
const teamReport = computed(() =>
  capacityReport(jira.issues, worklogs.value, {
    range: range.value ?? { from: today.value, to: today.value },
    today: today.value,
    granularity: granularityModel.value as CapacityGranularity,
  }),
);
const report = computed(() =>
  person.value === ALL
    ? teamReport.value
    : capacityReport(jira.issues, worklogs.value, {
        range: range.value ?? { from: today.value, to: today.value },
        today: today.value,
        granularity: granularityModel.value as CapacityGranularity,
        person: person.value,
      }),
);

function personName(p: CapacityPerson): string {
  return p.id === UNASSIGNED ? t('management.capacity.unassigned') : p.name || p.id;
}

const personOptions = computed<KSelectOption[]>(() => [
  { value: ALL, label: t('management.capacity.wholeTeam') },
  ...teamReport.value.persons.map((p) => ({ value: p.id, label: personName(p) })),
]);

// ── presentation ──────────────────────────────────────────────────────────────

// Utilization bands: the same four-step ladder the risk matrix uses, so the colours mean
// the same thing across Менеджмент.
function bandOf(u: number): 'idle' | 'ok' | 'high' | 'over' {
  if (u > 1.2) return 'over';
  if (u > 1) return 'high';
  if (u >= 0.8) return 'ok';
  return 'idle';
}

function percentOf(u: number): string {
  return `${Math.round(u * 100)}%`;
}

function issueUrl(key: string): string {
  const site = jira.integration?.siteUrl ?? '';
  return `${site.replace(/\/$/, '')}/browse/${key}`;
}

type TeamRow = { id: string; name: string; cells: CapacityCell[]; total: CapacityCell; open: number };

const teamTable = computed(() => person.value === ALL && !flaggedOnly.value);

const teamColumns = computed<KTableColumn[]>(() => [
  { key: 'person', label: t('management.capacity.col.person'), width: '160px' },
  ...report.value.periods.map((p, i) => ({
    key: `p${i}`,
    label: report.value.granularity === 'day' ? formatIsoDate(p.key).slice(0, 5) : formatIsoDate(p.from).slice(0, 5),
    align: 'right' as const,
    mono: true,
  })),
  { key: 'total', label: t('management.capacity.col.total'), align: 'right', width: '92px', mono: true },
  { key: 'util', label: t('management.capacity.col.util'), align: 'right', width: '64px', mono: true },
  { key: 'open', label: t('management.capacity.col.open'), align: 'right', width: '56px', mono: true },
]);

const teamRows = computed<TeamRow[]>(() => [
  ...report.value.persons.map((p) => ({
    id: p.id,
    name: personName(p),
    cells: report.value.cells[p.id]!,
    total: sumCells(report.value.cells[p.id]!),
    open: report.value.issues.filter((r) => r.person.id === p.id).length,
  })),
  { id: TEAM, name: t('management.capacity.teamTotal'), cells: report.value.totals, total: report.value.summary, open: report.value.issues.length },
]);

function cellTip(row: TeamRow, i: number): string {
  const c = row.cells[i]!;
  const p = report.value.periods[i]!;
  const period = report.value.granularity === 'day' ? formatIsoDate(p.key) : `${formatIsoDate(p.from)} – ${formatIsoDate(p.to)}`;
  return row.id === TEAM
    ? t('management.capacity.tipTeam', { load: hours(c.loadSeconds), cap: hours(c.capacitySeconds), period })
    : t('management.capacity.tip', { name: row.name, load: hours(c.loadSeconds), cap: hours(c.capacitySeconds), period });
}

const issueColumns = computed<KTableColumn[]>(() => [
  { key: 'key', label: t('management.capacity.col.key'), width: '92px', mono: true },
  { key: 'summary', label: t('management.capacity.col.summary') },
  { key: 'person', label: t('management.capacity.col.person'), width: '140px' },
  { key: 'status', label: t('management.capacity.col.status'), width: '110px' },
  { key: 'start', label: t('management.capacity.col.start'), width: '96px' },
  { key: 'due', label: t('management.capacity.col.due'), width: '96px' },
  { key: 'remaining', label: t('management.capacity.col.remaining'), align: 'right', width: '84px' },
  { key: 'inRange', label: t('management.capacity.col.inRange'), align: 'right', width: '84px' },
  { key: 'flag', label: t('management.capacity.col.flag'), width: '110px' },
]);

const issueRows = computed<CapacityIssueRow[]>(() =>
  flaggedOnly.value ? report.value.issues.filter((r) => r.flag) : report.value.issues,
);
</script>

<style scoped lang="scss">
.cap {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.cap__lead {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.cap__lead-workspace {
  color: var(--k-text);
}

.cap__gate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-3);
  max-width: 460px;
  padding: var(--k-sp-5);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.cap__gate-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.cap__gate-text,
.cap__blank-text {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.cap__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.cap__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--k-sp-2);

  > :nth-child(1),
  > :nth-child(2) {
    flex: 0 1 150px;
    min-width: 0;
  }

  > :nth-child(4) {
    flex: 0 1 200px;
    min-width: 0;
  }

  > :last-child {
    margin-left: auto;
  }
}

.cap__error {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.cap__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--k-sp-3);
}

.cap__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-3);
  text-align: left;
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.cap__stat--button {
  appearance: none;
  font: inherit;
  color: inherit;
  cursor: pointer;

  &:hover {
    border-color: var(--k-line-strong);
  }
}

.cap__stat--warn {
  border-color: color-mix(in srgb, var(--k-warning) 50%, transparent);
}

.cap__stat--active {
  border-color: var(--k-accent);
}

.cap__stat--ok .cap__stat-value {
  color: var(--k-success);
}

.cap__stat--high .cap__stat-value {
  color: var(--k-warning);
}

.cap__stat--over .cap__stat-value {
  color: var(--k-danger);
}

.cap__stat-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.cap__stat-value {
  font-family: var(--k-font-ui);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--k-text);

  small {
    margin-left: 2px;
    font-size: 12px;
    font-weight: 500;
    color: var(--k-muted);
  }
}

.cap__stat-note {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cap__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.cap__blank-hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.cap__table-wrap {
  overflow-x: auto;
}

.cap__cell {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--k-r-sm);
}

.cap__cell-cap {
  color: var(--k-faint);
}

.cap__cell--ok {
  background: color-mix(in srgb, var(--k-success) 18%, transparent);
}

.cap__cell--high {
  background: color-mix(in srgb, var(--k-warning) 22%, transparent);
}

.cap__cell--over {
  background: color-mix(in srgb, var(--k-danger) 30%, transparent);
}

.cap__strong {
  font-weight: 700;
}

.cap__dash {
  color: var(--k-faint);
}

.cap__overdue {
  color: var(--k-danger);
}

.cap__key {
  color: var(--k-text);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.cap__flag--overdue {
  color: var(--k-danger);
}

.cap__flag--unscheduled {
  color: var(--k-warning);
}
</style>
