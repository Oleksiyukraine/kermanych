<template>
  <KModal
    :model-value="modelValue"
    :title="risk ? t('risk.editor.titleEdit', { code: risk.code }) : t('risk.editor.titleNew')"
    width="760px"
    persistent
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <template #head-meta>
      <span class="rform__meta">
        <KTag v-if="risk">{{ t('risk.editor.raisedAt', { date: formatDate(risk.raisedAt) }) }}</KTag>
        <KTag v-if="risk">{{ t(statusLabel(risk.status)) }}</KTag>
        <KTag v-else>{{ workspaceName }}</KTag>
      </span>
    </template>

    <KTabs v-if="risk" v-model="tab" :tabs="TABS" />

    <div v-show="tab === 'risk'" class="rform">
      <!-- 1 · What kind of uncertainty, and which bucket. The category list is the same one
           the register audits itself against, so filing here is what closes a gap. -->
      <div class="rform__row rform__row--2">
        <KSelect v-model="kindModel" :label="t('risk.editor.kind')" :options="KIND_OPTIONS" />
        <KSelect v-model="draft.category" :label="t('risk.editor.category')" :options="CATEGORY_OPTIONS" />
      </div>

      <!-- 2 · The statement, in the three parts that make it scoreable. Three fields rather
           than one box: a single «опис» is how «the API might be a problem» gets in. -->
      <section class="rform__block">
        <h4 class="rform__legend">{{ t('risk.editor.statementLegend') }}</h4>
        <div class="rform__row rform__row--3">
          <KField
            v-model="draft.cause"
            :label="t('risk.editor.causeLabel')"
            :placeholder="t('risk.editor.causePlaceholder')"
            multiline
            :rows="3"
          />
          <KField
            v-model="draft.event"
            :label="draft.kind === 'opportunity' ? t('risk.editor.eventLabelOpportunity') : t('risk.editor.eventLabelThreat')"
            :placeholder="t('risk.editor.eventPlaceholder')"
            multiline
            :rows="3"
          />
          <KField
            v-model="draft.consequence"
            :label="t('risk.editor.consequenceLabel')"
            :placeholder="t('risk.editor.consequencePlaceholder')"
            multiline
            :rows="3"
          />
        </div>
        <p class="rform__preview">{{ t(statementPreview.key, statementPreview.params) }}</p>
      </section>

      <!-- 3 · Inherent score. The anchors are shown beside the grid because a 4 that means
           «висока» to one person and «точно станеться» to another is not a scale. -->
      <section class="rform__block">
        <h4 class="rform__legend">{{ t('risk.editor.inherentLegend') }}</h4>
        <div class="rform__score">
          <RiskMatrix
            :probability="draft.probability"
            :impact="draft.impact"
            interactive
            :aria-label="t('risk.editor.inherentLegend')"
            @pick="setInherent"
          />
          <dl class="rform__anchors">
            <dt class="mono">P{{ draft.probability }}</dt>
            <dd>{{ t(probabilityAnchor(draft.probability)) }}</dd>
            <dt class="mono">I{{ draft.impact }}</dt>
            <dd>{{ t(impactAnchor(draft.impact)) }}</dd>
            <dt class="mono">P×I</dt>
            <dd>
              <strong class="rform__exposure" :class="`rform__exposure--${bandOf(inherentExposure)}`">
                {{ inherentExposure }} · {{ t(bandLabel(bandOf(inherentExposure))) }}
              </strong>
            </dd>
          </dl>
        </div>
      </section>

      <!-- 4 · Proximity and the quantitative lane. EMV is optional per row but it is what
           justifies the contingency reserve, so the field sits with the score, not in a
           corner. -->
      <div class="rform__row rform__row--3">
        <KDateField
          v-model="draft.proximity"
          :label="t('risk.editor.proximity')"
          :now-ms="now"
        />
        <KField
          v-model="draft.costImpact"
          :label="t('risk.editor.costImpact')"
          placeholder="40 000"
        />
        <KField
          v-model="draft.probabilityPct"
          :label="t('risk.editor.probabilityPct')"
          placeholder="45"
        />
      </div>
      <p v-if="emvPreview" class="rform__note mono">{{ t('risk.editor.emvNote', { value: emvPreview }) }}</p>

      <!-- 5 · The response. «Monitor» is not a response, so actions, an owner and a date are
           required for every strategy but «прийняти». -->
      <section class="rform__block">
        <h4 class="rform__legend">{{ t('risk.editor.responseLegend') }}</h4>
        <div class="rform__row rform__row--2">
          <KSelect v-model="responseModel" :label="t('risk.editor.strategy')" :options="responseOptions" />
          <KSelect
            v-model="draft.riskOwner"
            :label="t('risk.editor.riskOwnerLabel')"
            :options="members"
            :placeholder="t('risk.editor.selectPerson')"
          />
        </div>
        <KField
          v-model="draft.responseActions"
          :label="draft.response === 'accept' ? t('risk.editor.responseActionsAccept') : t('risk.editor.responseActionsLabel')"
          :placeholder="t('risk.editor.responseActionsPlaceholder')"
          multiline
          :rows="2"
        />
        <div class="rform__row rform__row--2">
          <KSelect
            v-model="draft.actionOwner"
            :label="t('risk.editor.actionOwner')"
            :options="members"
            :placeholder="t('risk.editor.selectPerson')"
          />
          <KDateField v-model="draft.actionDue" :label="t('risk.editor.actionDue')" :now-ms="now" />
        </div>
      </section>

      <!-- 6 · Residual. The number a steering committee reads to see what the mitigation
           actually bought — which is why the delta is spelled out rather than left to be
           subtracted in someone's head. -->
      <section class="rform__block">
        <h4 class="rform__legend">{{ t('risk.editor.residualLegend') }}</h4>
        <div class="rform__score">
          <RiskMatrix
            :probability="draft.residualProbability || undefined"
            :impact="draft.residualImpact || undefined"
            interactive
            :aria-label="t('risk.editor.residualAria')"
            @pick="setResidual"
          />
          <div class="rform__anchors">
            <p v-if="!hasResidual" class="rform__hint">{{ t('risk.editor.residualUnset') }}</p>
            <template v-else>
              <p class="rform__hint">
                <strong
                  class="rform__exposure"
                  :class="`rform__exposure--${bandOf(residualExposure)}`"
                >
                  {{ residualExposure }} · {{ t(bandLabel(bandOf(residualExposure))) }}
                </strong>
              </p>
              <p class="rform__hint">{{ t('risk.editor.residualGain', { n: inherentExposure - residualExposure }) }}</p>
              <KBtn variant="ghost" @click="clearResidual">{{ t('risk.editor.clearResidual') }}</KBtn>
            </template>
          </div>
        </div>
      </section>

      <!-- 7 · The early-warning indicator and the lifecycle. -->
      <KField
        v-model="draft.earlyWarning"
        :label="t('risk.editor.earlyWarning')"
        :placeholder="t('risk.editor.earlyWarningPlaceholder')"
        multiline
        :rows="2"
      />

      <div class="rform__row rform__row--2">
        <KSelect v-model="statusModel" :label="t('risk.editor.status')" :options="STATUS_OPTIONS" />
        <KField
          v-if="isTerminal"
          v-model="draft.closureNote"
          :label="draft.status === 'closed' ? t('risk.editor.closureNoteClosed') : t('risk.editor.closureNoteMaterialized')"
          multiline
          :rows="2"
        />
      </div>

      <!-- The tolerance line, stated where the decision is made rather than in a policy
           document nobody has open. -->
      <p v-if="overTolerance" class="rform__alert">
        {{ t('risk.editor.toleranceAlert', { effective, threshold: ESCALATION_EXPOSURE }) }}
      </p>

      <ul v-if="errors.length" ref="errorsEl" class="rform__errors">
        <li v-for="(e, idx) in errors" :key="idx">{{ t('risk.validation.' + e) }}</li>
      </ul>
    </div>

    <!-- The audit trail. It is the whole reason a risk is closed rather than deleted, so it
         is one tab away from the row, not in a separate screen. -->
    <div v-if="risk" v-show="tab === 'history'" class="rform__history">
      <p v-if="!events.length" class="rform__hint">{{ t('risk.editor.historyEmpty') }}</p>
      <article v-for="e in events" :key="e.id" class="rform__event">
        <span class="rform__event-kind">{{ t(eventLabel(e.kind)) }}</span>
        <span v-if="e.toValue" class="rform__event-values mono">
          <template v-if="e.fromValue">{{ t(eventValueLabel(e.kind, e.fromValue)) }} → </template>
          {{ t(eventValueLabel(e.kind, e.toValue)) }}
        </span>
        <span class="rform__event-who">{{ memberName(e.actor) }}</span>
        <span class="rform__event-at mono">{{ relativeTime(e.at, now) }}</span>
      </article>
    </div>

    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('risk.editor.cancel') }}</KBtn>
      <KBtn variant="primary" :disabled="busy" @click="submit">
        {{ busy ? t('risk.editor.saving') : risk ? t('risk.editor.save') : t('risk.editor.create') }}
      </KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// The one screen where a risk is written, scored, responded to and closed. Everything it
// DECIDES is imported from lib/risk.ts — this component only wires fields to that module and
// to the store, so the rules stay testable without a component harness.
//
// There is no delete control anywhere in here, on purpose: the table grants no `delete` to
// anyone. A risk leaves the register through the status field, with a note.
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  RiskKind,
  RiskResponse,
  RiskStatus,
  WorkspaceRisk,
} from '@kermanych/cloud';
import type { KSelectOption } from 'components/kit/KSelect.vue';
import KModal from 'components/kit/KModal.vue';
import KTabs from 'components/kit/KTabs.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import RiskMatrix from './RiskMatrix.vue';
import { useRisks } from 'stores/risks';
import { useOrchestrator } from 'stores/orchestrator';
import { useNow } from '../../composables/useNow';
import { relativeTime } from '../../lib/time';
import {
  ESCALATION_EXPOSURE,
  RISK_CATEGORIES,
  RISK_KINDS,
  RISK_STATUSES,
  bandLabel,
  bandOf,
  categoryLabel,
  draftOf,
  draftToInsert,
  draftToPatch,
  emptyDraft,
  eventLabel,
  eventValueLabel,
  formatDate,
  impactAnchor,
  kindLabel,
  money,
  parseAmount,
  probabilityAnchor,
  responseLabel,
  responsesFor,
  statementOf,
  statusLabel,
  validateDraft,
  type RiskDraft,
  type RiskError,
} from '../../lib/risk';

const props = defineProps<{
  modelValue: boolean;
  workspaceId: string;
  workspaceName: string;
  // Absent = the «new risk» form. Present = editing that row.
  risk?: WorkspaceRisk | undefined;
  // Workspace members, already shaped for KSelect by the page.
  members: KSelectOption[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [risk: WorkspaceRisk] }>();

const store = useRisks();
// Toasts, for the one thing this dialog cannot show inline: a write the database refused.
const local = useOrchestrator();
const now = useNow(30_000);
const { t } = useI18n();

const TABS = computed(() => [
  { value: 'risk', label: t('risk.editor.tabRisk') },
  { value: 'history', label: t('risk.editor.tabHistory') },
]);
const KIND_OPTIONS = computed<KSelectOption[]>(() =>
  RISK_KINDS.map((value) => ({ value, label: t(kindLabel(value)) })),
);
const CATEGORY_OPTIONS = computed<KSelectOption[]>(() =>
  RISK_CATEGORIES.map((value) => ({ value, label: t(categoryLabel(value)) })),
);
const STATUS_OPTIONS = computed<KSelectOption[]>(() =>
  RISK_STATUSES.map((value) => ({ value, label: t(statusLabel(value)) })),
);

const tab = ref('risk');
const busy = ref(false);
// Empty until the first save attempt, then live: nagging about a blank cause while the user
// is still typing it is how a form teaches people to ignore it.
const errors = ref<RiskError[]>([]);
const errorsEl = useTemplateRef<HTMLElement>('errorsEl');
const draft = ref<RiskDraft>(emptyDraft(Date.now()));

// Reset on every open, not on mount: the modal instance outlives the row it was opened for,
// and a stale draft would silently overwrite the next risk edited.
watch(
  () => [props.modelValue, props.risk?.id] as const,
  ([open]) => {
    if (!open) return;
    if (props.risk) {
      draft.value = draftOf(props.risk);
      void store.loadEvents(props.risk.id);
    } else {
      draft.value = emptyDraft(Date.now());
    }
    errors.value = [];
    tab.value = 'risk';
  },
  { immediate: true },
);

const events = computed(() => (props.risk ? (store.eventsByRisk[props.risk.id] ?? []) : []));

// KSelect models are strings; these three narrow back to their enums on the way in, and the
// kind switch also repairs a strategy that its new direction does not allow.
const kindModel = computed({
  get: () => draft.value.kind as string,
  set: (v: string) => {
    const kind = v as RiskKind;
    draft.value.kind = kind;
    if (!responsesFor(kind).some((r) => r.value === draft.value.response)) {
      draft.value.response = kind === 'threat' ? 'reduce' : 'enhance';
    }
  },
});

const responseModel = computed({
  get: () => draft.value.response as string,
  set: (v: string) => {
    draft.value.response = v as RiskResponse;
  },
});

const statusModel = computed({
  get: () => draft.value.status as string,
  set: (v: string) => {
    draft.value.status = v as RiskStatus;
  },
});

const responseOptions = computed<KSelectOption[]>(() =>
  responsesFor(draft.value.kind).map((r) => ({ value: r.value, label: t(responseLabel(r.value)) })),
);

const inherentExposure = computed(() => draft.value.probability * draft.value.impact);
const hasResidual = computed(() => draft.value.residualProbability > 0 && draft.value.residualImpact > 0);
const residualExposure = computed(() => draft.value.residualProbability * draft.value.residualImpact);
const effective = computed(() => (hasResidual.value ? residualExposure.value : inherentExposure.value));
const overTolerance = computed(() => effective.value >= ESCALATION_EXPOSURE);
const isTerminal = computed(() => draft.value.status === 'closed' || draft.value.status === 'materialized');
const statementPreview = computed(() => statementOf(draft.value));

const emvPreview = computed(() => {
  const cost = parseAmount(draft.value.costImpact);
  const pct = parseAmount(draft.value.probabilityPct);
  if (cost === undefined || pct === undefined || Number.isNaN(cost) || Number.isNaN(pct)) return '';
  return money((cost * pct) / 100);
});

function setInherent(probability: number, impact: number): void {
  draft.value.probability = probability;
  draft.value.impact = impact;
}

function setResidual(probability: number, impact: number): void {
  draft.value.residualProbability = probability;
  draft.value.residualImpact = impact;
}

function clearResidual(): void {
  draft.value.residualProbability = 0;
  draft.value.residualImpact = 0;
}

function memberName(id: string | undefined): string {
  if (!id) return '—';
  return props.members.find((m) => m.value === id)?.label ?? id;
}

async function submit(): Promise<void> {
  errors.value = validateDraft(draft.value);
  if (errors.value.length) {
    // The form scrolls inside the dialog, so the list can land below the fold — a submit
    // that looks like it did nothing is how a user concludes the button is broken.
    await nextTick();
    errorsEl.value?.scrollIntoView({ block: 'nearest' });
    return;
  }
  busy.value = true;
  try {
    // The store throws on a rejected write (RLS, a CHECK constraint, an unreachable
    // Supabase). The dialog stays open with the draft intact: everything typed here is worth
    // more than the error, and the fix is usually one field away.
    const saved = props.risk
      ? await store.save(props.workspaceId, props.risk.id, draftToPatch(draft.value))
      : await store.create(props.workspaceId, draftToInsert(props.workspaceId, draft.value));
    emit('saved', saved);
    emit('update:modelValue', false);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
  }
}

// Re-validate live once the user has been told what is wrong, so a fixed field stops
// complaining without a second submit.
watch(
  draft,
  () => {
    if (errors.value.length) errors.value = validateDraft(draft.value);
  },
  { deep: true },
);
</script>

<style scoped lang="scss">
.rform {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // The form is long by nature — thirteen columns is what a register row is. Scrolling it
  // inside the dialog keeps the header, the tabs and the two controls always reachable.
  max-height: 62vh;
  overflow-y: auto;
  padding: var(--k-sp-3) 2px 2px;
  color: var(--k-text);
}

.rform__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.rform__row {
  display: grid;
  gap: var(--k-sp-3);
}

.rform__row--2 {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.rform__row--3 {
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.rform__block {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 34%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.rform__legend {
  margin: 0;
  font-family: var(--k-font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: var(--k-fw-regular);
  color: var(--k-muted);
}

// The sentence the register will actually report, updating as the three parts are typed —
// which is what makes an unscoreable statement obvious before it is saved.
.rform__preview {
  margin: 0;
  font-size: var(--k-fs-base);
  line-height: 1.55;
  color: var(--k-text);
  border-left: var(--k-rule-strong) solid var(--k-accent);
  padding-left: var(--k-sp-3);
}

.rform__score {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: var(--k-sp-4);
  align-items: start;
}

.rform__anchors {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 4px var(--k-sp-3);
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);

  dt {
    font-size: var(--k-fs-xs);
    color: var(--k-faint);
  }

  dd {
    margin: 0;
    color: var(--k-text);
  }
}

.rform__hint {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.rform__exposure {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-base);
}

.rform__exposure--low {
  color: var(--k-success);
}

.rform__exposure--medium {
  color: var(--k-warning);
}

.rform__exposure--high {
  color: var(--k-accent);
}

.rform__exposure--extreme {
  color: var(--k-danger);
}

.rform__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

// The tolerance breach, styled as a statement rather than a warning icon: it is a routing
// instruction — this one goes to the sponsor.
.rform__alert {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-danger) 12%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-danger);
  border-radius: 0 var(--k-r-sm) var(--k-r-sm) 0;
}

.rform__errors {
  margin: 0;
  padding: var(--k-sp-3) var(--k-sp-3) var(--k-sp-3) var(--k-sp-6);
  font-size: var(--k-fs-sm);
  line-height: 1.6;
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.rform__history {
  display: flex;
  flex-direction: column;
  max-height: 62vh;
  overflow-y: auto;
  padding-top: var(--k-sp-3);
  color: var(--k-text);
}

.rform__event {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) 120px 92px;
  gap: var(--k-sp-3);
  align-items: baseline;
  padding: var(--k-sp-2) 0;
  border-bottom: var(--k-rule-thin) solid var(--k-line);
  font-size: var(--k-fs-sm);
}

.rform__event-kind {
  font-weight: var(--k-fw-medium);
}

.rform__event-values {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rform__event-who {
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rform__event-at {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  text-align: right;
}
</style>
