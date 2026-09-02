<template>
  <section class="risk">
    <p class="risk__lead">
      {{ t('management.risks.leadBefore') }}
      <span class="risk__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.risks.leadAfter') }}
    </p>

    <!-- The four numbers a status report opens with. Every one of them is derived from the
         register, so none of them can quietly disagree with the rows below. -->
    <div class="risk__summary">
      <div class="risk__stats">
        <article class="risk__stat">
          <span class="risk__stat-label mono">{{ t('management.risks.statLive') }}</span>
          <strong class="risk__stat-value">{{ liveCount }}</strong>
          <span class="risk__stat-note">{{ t('management.risks.statLiveNote', { total: all.length }) }}</span>
        </article>
        <article class="risk__stat" :class="{ 'risk__stat--alarm': escalations.length }">
          <span class="risk__stat-label mono">{{ t('management.risks.statOverTolerance') }}</span>
          <strong class="risk__stat-value">{{ escalations.length }}</strong>
          <span class="risk__stat-note">{{ t('management.risks.statOverToleranceNote', { exposure: ESCALATION_EXPOSURE }) }}</span>
        </article>
        <article class="risk__stat" :class="{ 'risk__stat--warn': staleCount }">
          <span class="risk__stat-label mono">{{ t('management.risks.statOverdue') }}</span>
          <strong class="risk__stat-value">{{ staleCount }}</strong>
          <span class="risk__stat-note">{{ t('management.risks.statOverdueNote', { days: REVIEW_CADENCE_DAYS }) }}</span>
        </article>
        <article class="risk__stat">
          <span class="risk__stat-label mono">{{ t('management.risks.statReserve') }}</span>
          <strong class="risk__stat-value">{{ reserve ? money(reserve) : '—' }}</strong>
          <span class="risk__stat-note">{{ t('management.risks.statReserveNote', { count: quantified }) }}</span>
        </article>
      </div>

      <!-- The heat map doubles as a filter: clicking a cell narrows the table to it, which is
           the fastest way to answer «покажи все, що в червоному куті». -->
      <article class="risk__card">
        <h3 class="risk__card-title mono">{{ t('management.risks.matrixTitle') }}</h3>
        <RiskMatrix
          :counts="counts"
          :selected-cell="filter.cell"
          interactive
          :aria-label="t('management.risks.matrixAria')"
          @pick="toggleCell"
        />
        <button v-if="filter.cell" class="risk__card-clear" type="button" @click="filter.cell = ''">
          {{ t('management.risks.clearCells') }}
        </button>
      </article>

      <!-- Top-N, not all-N: a status report carries these plus anything newly escalated, and
           the full register stays in the tool. -->
      <article class="risk__card">
        <h3 class="risk__card-title mono">{{ t('management.risks.topTitle') }}</h3>
        <ol v-if="top.length" class="risk__top">
          <li v-for="r in top" :key="r.id" class="risk__top-row" @click="edit(r)">
            <span class="risk__top-code mono">{{ r.code }}</span>
            <span class="risk__top-text">{{ r.event }}</span>
            <span class="risk__score" :class="`risk__score--${bandOf(effectiveExposure(r))}`">
              {{ effectiveExposure(r) }}
            </span>
          </li>
        </ol>
        <p v-else class="risk__card-empty">{{ t('management.risks.topEmpty') }}</p>
      </article>
    </div>

    <div class="risk__toolbar">
      <KField v-model="filter.query" :placeholder="t('management.risks.searchPlaceholder')" />
      <KSelect v-model="categoryModel" :options="CATEGORY_OPTIONS" :placeholder="t('management.risks.allCategories')" />
      <KSelect v-model="statusModel" :options="STATUS_OPTIONS" />
      <KSelect v-model="sortModel" :options="SORT_OPTIONS" />
      <KCheckbox v-model="filter.aboveTolerance" :label="t('management.risks.aboveToleranceOnly')" />
      <KBtn variant="primary" @click="create()">{{ t('management.risks.newRisk') }}</KBtn>
    </div>

    <p v-if="store.loadError" class="risk__error">
      {{ t('management.risks.loadError', { error: store.loadError }) }}
    </p>

    <div v-else-if="!rows.length" class="risk__blank">
      <span class="risk__blank-eyebrow mono">{{ t('management.risks.blankEyebrow') }}</span>
      <p class="risk__blank-text">
        {{ all.length ? t('management.risks.blankFiltered') : t('management.risks.blankEmpty') }}
      </p>
    </div>

    <div v-else class="risk__table-wrap">
      <KTable
        class="risk__table"
        :columns="COLUMNS"
        :rows="rows"
        :row-key="(r: WorkspaceRisk) => r.id"
        :row-class="rowClass"
        clickable
        @row-click="edit"
      >
        <template #cell-code="{ row }">
          <span class="risk__code mono">{{ row.code }}</span>
        </template>

        <template #cell-statement="{ row }">
          <div class="risk__statement">
            <span class="risk__statement-text">{{ statementText(row) }}</span>
            <span class="risk__statement-meta">
              <KTag>{{ t(categoryLabel(row.category)) }}</KTag>
              <KTag v-if="row.kind === 'opportunity'">{{ t('management.risks.kindOpportunity') }}</KTag>
              <KTag>{{ t(responseLabel(row.response)) }}</KTag>
            </span>
          </div>
        </template>

        <template #cell-score="{ row }">
          <span class="risk__score" :class="`risk__score--${bandOf(row.exposure)}`" v-tip="`P${row.probability} × I${row.impact}`">
            {{ row.exposure }}
          </span>
        </template>

        <template #cell-residual="{ row }">
          <span
            v-if="row.residualExposure !== undefined"
            class="risk__score"
            :class="`risk__score--${bandOf(row.residualExposure)}`"
            v-tip="`P${row.residualProbability} × I${row.residualImpact}`"
          >
            {{ row.residualExposure }}
          </span>
          <span v-else class="risk__dash mono">{{ t('management.risks.notScored') }}</span>
        </template>

        <template #cell-proximity="{ row }">
          <span class="risk__prox" :class="`risk__prox--${proximityOf(row.proximity, now)}`">
            {{ dueText(row.proximity) }}
          </span>
        </template>

        <template #cell-owner="{ row }">
          <span :class="{ risk__dash: !row.riskOwner }">{{ memberName(row.riskOwner) }}</span>
        </template>

        <template #cell-review="{ row }">
          <span :class="{ 'risk__stale': reviewOverdue(row, now) }">
            {{ renderTime(t, relativeTime(row.lastReviewedAt, now)) }}
          </span>
        </template>

        <template #cell-status="{ row }">
          <KTag plain>{{ t(statusLabel(row.status)) }}</KTag>
        </template>

        <template #cell-actions="{ row }">
          <div class="risk__actions">
            <!-- Recording a review is one click, because a cadence that costs a modal is a
                 cadence nobody keeps. There is no delete button: the register is append-only
                 and a risk leaves it through its status. -->
            <KIconButton
              :title="t('management.risks.reviewMark')"
              :disabled="!isLive(row) || reviewing === row.id"
              @click.stop="review(row)"
            >
              ✓
            </KIconButton>
            <KIconButton :title="t('management.risks.open')" @click.stop="edit(row)">✎</KIconButton>
          </div>
        </template>
      </KTable>
    </div>

    <!-- The risk management plan, quoted where the register is read. These are the numbers
         every score, every escalation and every review date on this page is measured against;
         they are agreed once for the whole workspace and live in lib/risk.ts. -->
    <p class="risk__plan mono">
      {{ t('management.risks.plan', { exposure: ESCALATION_EXPOSURE, days: REVIEW_CADENCE_DAYS }) }}
    </p>

    <RiskEditor
      v-model="editorOpen"
      :workspace-id="workspaceId"
      :workspace-name="workspaceName"
      :risk="editing"
      :members="memberOptions"
    />
  </section>
</template>

<script setup lang="ts">
// Risk Registry — the Менеджмент section that actually manages something. The shell above
// (ManagementPage) already renders the heading, the workspace chip and the «pick a
// workspace» gate, so this component renders only the register itself and can assume a
// workspace.
//
// It holds view state (filter, sort, which row is open) and nothing else: every rule it
// applies — scoring, tolerance, review cadence, top-N — comes from lib/risk.ts, and every
// write goes through stores/risks.ts.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RiskCategory, WorkspaceRisk } from '@kermanych/cloud';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import RiskMatrix from 'components/risk/RiskMatrix.vue';
import RiskEditor from 'components/risk/RiskEditor.vue';
import { useRisks } from 'stores/risks';
import { useProjects } from 'stores/projects';
import { useNow } from '../composables/useNow';
import { relativeTime, renderTime } from '../lib/time';
import {
  EMPTY_FILTER,
  ESCALATION_EXPOSURE,
  REVIEW_CADENCE_DAYS,
  RISK_CATEGORIES,
  SORTS,
  STATUS_FILTERS,
  sortLabel,
  statusFilterLabel,
  bandOf,
  categoryLabel,
  contingencyReserve,
  dueLabel,
  effectiveExposure,
  filterRisks,
  isLive,
  matrixCounts,
  money,
  needsEscalation,
  proximityOf,
  quantifiedCount,
  responseLabel,
  reviewOverdue,
  sortRisks,
  statementOf,
  statusLabel,
  topByExposure,
  type RiskSort,
  type RiskStatusFilter,
} from '../lib/risk';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const store = useRisks();
const projects = useProjects();

const { t } = useI18n();
// Proximity, overdue reviews and «переглянуто N дн тому» are all relative, so the page needs
// a clock. A minute is plenty for a screen measured in days.
const now = useNow(60_000);

const COLUMNS = computed<KTableColumn[]>(() => [
  { key: 'code', label: 'ID', width: '70px', mono: true },
  { key: 'statement', label: t('management.risks.colStatement') },
  { key: 'score', label: 'P×I', align: 'center', width: '62px' },
  { key: 'residual', label: t('management.risks.colResidual'), align: 'center', width: '82px' },
  { key: 'proximity', label: t('management.risks.colProximity'), width: '116px' },
  { key: 'owner', label: t('management.risks.colOwner'), width: '132px' },
  { key: 'review', label: t('management.risks.colReview'), width: '112px' },
  { key: 'status', label: t('management.risks.colStatus'), width: '104px' },
  { key: 'actions', label: '', align: 'right', width: '78px' },
]);

const CATEGORY_OPTIONS = computed<KSelectOption[]>(() =>
  RISK_CATEGORIES.map((value) => ({ value, label: t(categoryLabel(value)) })),
);
const STATUS_OPTIONS = computed<KSelectOption[]>(() =>
  STATUS_FILTERS.map((value) => ({ value, label: t(statusFilterLabel(value)) })),
);
const SORT_OPTIONS = computed<KSelectOption[]>(() =>
  SORTS.map((value) => ({ value, label: t(sortLabel(value)) })),
);

const filter = reactive({ ...EMPTY_FILTER });
const sort = ref<RiskSort>('exposure');
const editorOpen = ref(false);
const editing = ref<WorkspaceRisk | undefined>(undefined);
// The row whose review is being recorded, so its tick cannot be double-clicked into two
// writes while the first is in flight.
const reviewing = ref('');

// The register is read on open and whenever the sidebar moves to another workspace. No
// Realtime channel: see the header of stores/risks.ts.
watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.load(id);
  },
  { immediate: true },
);

// Member list for the owner pickers. The roster is workspace-scoped — and so is the register
// now — so it reads the register's own prop instead of deriving a workspace from the cloud
// project list, which had to have been loaded before an owner could be picked.
watch(
  () => props.workspaceId,
  (id) => {
    if (id && !projects.members[id]) void projects.loadMembers(id);
  },
  { immediate: true },
);

const memberOptions = computed<KSelectOption[]>(() =>
  (projects.members[props.workspaceId] ?? []).map((m) => ({
    value: m.userId,
    label: m.profile?.displayName ?? m.profile?.githubUsername ?? m.userId,
  })),
);

const all = computed<WorkspaceRisk[]>(() => store.byWorkspace[props.workspaceId] ?? []);
const live = computed(() => all.value.filter(isLive));
const liveCount = computed(() => live.value.length);
const escalations = computed(() => all.value.filter(needsEscalation));
const staleCount = computed(() => all.value.filter((r) => reviewOverdue(r, now.value)).length);
const reserve = computed(() => contingencyReserve(all.value));
const quantified = computed(() => quantifiedCount(all.value));
const counts = computed(() => matrixCounts(all.value));
const top = computed(() => topByExposure(all.value, 5));

const rows = computed(() => sortRisks(filterRisks(all.value, filter), sort.value));

// KSelect speaks strings; these three narrow back to the filter's own unions on the way in.
const categoryModel = computed({
  get: () => filter.category as string,
  set: (v: string) => {
    filter.category = v as RiskCategory | '';
  },
});

const statusModel = computed({
  get: () => filter.status as string,
  set: (v: string) => {
    filter.status = v as RiskStatusFilter;
  },
});

const sortModel = computed({
  get: () => sort.value as string,
  set: (v: string) => {
    sort.value = v as RiskSort;
  },
});

function memberName(id: string | undefined): string {
  if (!id) return t('management.risks.memberUnassigned');
  return memberOptions.value.find((m) => m.value === id)?.label ?? id;
}

// statementOf/dueLabel are pure and i18n-blind: they return keys+params, rendered here.
function statementText(row: WorkspaceRisk): string {
  const s = statementOf(row);
  return t(s.key, s.params);
}

function dueText(date: string | undefined): string {
  const d = dueLabel(date, now.value);
  return d.params ? t(d.key, d.params, d.params.n) : t(d.key);
}

// Clicking the cell you are already filtered to clears the filter — the same toggle the
// heat map's own outline is showing.
function toggleCell(probability: number, impact: number): void {
  const key = `${probability}:${impact}`;
  filter.cell = filter.cell === key ? '' : key;
}

function edit(risk: WorkspaceRisk): void {
  editing.value = risk;
  editorOpen.value = true;
}

function create(): void {
  editing.value = undefined;
  editorOpen.value = true;
}

async function review(risk: WorkspaceRisk): Promise<void> {
  reviewing.value = risk.id;
  await store.markReviewed(props.workspaceId, risk.id);
  reviewing.value = '';
}

// Two row states worth seeing without reading a cell: over the tolerance line, and overdue
// for its review. Escalation wins — it is the one that has to leave the room.
function rowClass(risk: WorkspaceRisk): string | undefined {
  if (needsEscalation(risk)) return 'risk__row--hot';
  if (reviewOverdue(risk, now.value)) return 'risk__row--stale';
  return undefined;
}
</script>

<style scoped lang="scss">
.risk {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // Full width, unlike the 680px Integrations column: a register row carries thirteen facts
  // and a narrow measure would turn every one of them into an ellipsis.
  width: 100%;
  padding: var(--k-sp-3) 0;
  // The register is taller than the frame from the second risk on; `.mgmt__body` centres
  // with `safe center` precisely so that this section pins to the top and scrolls.
}

.risk__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.risk__lead-workspace {
  color: var(--k-text);
}

.risk__summary {
  display: grid;
  grid-template-columns: minmax(0, 2fr) 232px minmax(240px, 1fr);
  gap: var(--k-sp-3);
  align-items: stretch;
}

.risk__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-3);
}

.risk__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

// A count that has to be acted on gets a coloured edge rather than a coloured number: the
// figure stays readable, the edge is what catches the eye across the page.
.risk__stat--alarm {
  border-left: var(--k-rule-strong) solid var(--k-danger);
}

.risk__stat--warn {
  border-left: var(--k-rule-strong) solid var(--k-warning);
}

.risk__stat-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.risk__stat-value {
  font-family: var(--k-font-ui);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--k-text);
}

.risk__stat-note {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.risk__card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.risk__card-title {
  margin: 0;
  font-size: 10px;
  font-weight: var(--k-fw-regular);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.risk__card-empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.risk__card-clear {
  appearance: none;
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-family: var(--k-font-mono);
  font-size: 10px;
  color: var(--k-accent);
  cursor: pointer;
}

.risk__top {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.risk__top-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 28px;
  gap: var(--k-sp-2);
  align-items: center;
  padding: 4px 6px;
  margin: 0 -6px;
  border-radius: var(--k-r-sm);
  font-size: var(--k-fs-sm);
  cursor: pointer;

  &:hover {
    background: color-mix(in srgb, var(--k-surface2) 70%, transparent);
  }
}

.risk__top-code {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.risk__top-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--k-text);
}

// One severity chip, used in the top list, both score columns and the editor, so a 16 looks
// the same everywhere it appears.
.risk__score {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  padding: 1px 6px;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  border-radius: var(--k-r-sm);
  color: var(--k-text);
}

.risk__score--low {
  background: color-mix(in srgb, var(--k-success) 22%, transparent);
}

.risk__score--medium {
  background: color-mix(in srgb, var(--k-warning) 26%, transparent);
}

.risk__score--high {
  background: color-mix(in srgb, var(--k-accent) 26%, transparent);
}

.risk__score--extreme {
  background: color-mix(in srgb, var(--k-danger) 40%, transparent);
}

.risk__toolbar {
  // One height for the whole strip. Left alone the kit hands out 35px for the <input>, the
  // select trigger and the button — close, but the checkbox is a 16px control, so the row
  // still needed one number. Pinned here, not in the kit, because only this row mixes all
  // four.
  --risk-toolbar-h: 36px;

  display: flex;
  flex-wrap: wrap;
  // Centred, not bottom-aligned: the checkbox is a 16px control, so flex-end dropped its label
  // onto the button's bottom edge whenever the row wrapped.
  align-items: center;
  gap: var(--k-sp-2);

  :deep(.k-field__input),
  :deep(.k-select__input),
  :deep(.k-btn),
  :deep(.k-checkbox) {
    box-sizing: border-box;
    height: var(--risk-toolbar-h);
  }

  // The kit's fields are labelled block elements; here they sit in one unlabelled strip, so
  // each gets an explicit measure instead of stretching to whatever is left.
  > :first-child {
    flex: 1 1 240px;
    min-width: 200px;
  }

  // «Постачальник, SaaS-залежність, vendor lock-in» is 45 characters, and KSelect reserves
  // the width of its LONGEST option — left to itself the category filter eats the strip.
  // Fixed measures here; the trigger ellipsises inside them.
  > :nth-child(2) {
    flex: 0 1 200px;
    min-width: 0;
  }

  > :nth-child(3),
  > :nth-child(4) {
    flex: 0 1 168px;
    min-width: 0;
  }

  > :last-child {
    margin-left: auto;
  }
}

.risk__error {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.risk__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.risk__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.risk__blank-text {
  margin: 0;
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

// Nine columns of facts do not fit a narrow window, and dropping one would be dropping a
// field the standard requires. The table scrolls sideways instead.
.risk__table-wrap {
  overflow-x: auto;
}

.risk__table {
  min-width: 1040px;
}

.risk__code {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.risk__statement {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 260px;
}

// Two lines of the composed sentence: enough to judge whether it is a real statement, short
// enough that ten rows still fit on a screen.
.risk__statement-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}

.risk__statement-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.risk__dash {
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
}

.risk__prox--passed {
  color: var(--k-danger);
}

.risk__prox--immediate {
  color: var(--k-accent);
}

.risk__prox--unset {
  color: var(--k-faint);
}

.risk__stale {
  color: var(--k-warning);
}

.risk__actions {
  display: inline-flex;
  gap: 4px;
}

// Row state rides in through KTable's `rowClass`, so the rule has to reach into the table.
.risk__table :deep(tr.risk__row--hot td:first-child) {
  box-shadow: inset 2px 0 0 0 var(--k-danger);
}

.risk__table :deep(tr.risk__row--stale td:first-child) {
  box-shadow: inset 2px 0 0 0 var(--k-warning);
}

.risk__plan {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--k-faint);
}

@media (max-width: 1180px) {
  .risk__summary {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
