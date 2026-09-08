<template>
  <div class="riskw">
    <p v-if="store.loadError" class="riskw__note riskw__note--error mono">
      {{ t('management.home.risks.error', { error: store.loadError }) }}
    </p>
    <p v-else-if="!highlighted.length" class="riskw__note mono">
      {{ t('management.home.risks.empty') }}
    </p>

    <!-- The rows that cannot wait for the weekly review: every live risk in the high or extreme
         band (over the PM's tolerance → the sponsor's), plus any whose window is closing — its
         proximity is this sprint or already passed, or its action is due within a fortnight. -->
    <ol v-else class="riskw__list">
      <li v-for="r in highlighted" :key="r.risk.id" class="riskw__row">
        <RouterLink class="riskw__link" :to="{ name: 'management-risks' }">
          <span class="riskw__head">
            <span class="riskw__code mono">{{ r.risk.code }}</span>
            <span class="riskw__band" :class="`riskw__band--${r.band}`">{{ t(bandLabel(r.band)) }}</span>
            <span v-if="r.escalate" class="riskw__escalate mono">{{ t('management.home.risks.escalate') }}</span>
          </span>
          <span class="riskw__event">{{ r.risk.event }}</span>
          <span class="riskw__due" :class="`riskw__due--${r.proximity}`">{{ r.dueText }}</span>
        </RouterLink>
      </li>
    </ol>

    <RouterLink v-if="highlighted.length" class="riskw__all mono" :to="{ name: 'management-risks' }">
      {{ t('management.home.risks.open') }} →
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
// The risk register, triaged to what needs a look now: high & critical live risks and risks
// whose window is closing. It reads the same risks store the full register does and reuses its
// pure rules (lib/risk.ts) for scoring, banding and proximity, so a row highlighted here is
// scored exactly as it is on the register screen. Read-only: risks are filed and edited there.
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { WorkspaceRisk } from '@kermanych/cloud';
import { useRisks } from 'stores/risks';
import { useNow } from '../../composables/useNow';
import {
  type RiskBand,
  type Proximity,
  bandLabel,
  bandOf,
  daysUntil,
  dueLabel,
  effectiveExposure,
  isLive,
  needsEscalation,
  proximityOf,
} from '../../lib/risk';

const props = defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const store = useRisks();
const now = useNow(60_000);

watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.load(id);
  },
  { immediate: true },
);

const BAND_RANK: Record<RiskBand, number> = { low: 0, medium: 1, high: 2, extreme: 3 };

// The soonest calendar distance that makes a risk urgent: the nearer of its proximity date and
// its action-due date. Undefined when neither is set — such a risk qualifies only by its band.
function urgencyDays(r: WorkspaceRisk): number | undefined {
  const candidates = [r.proximity, r.actionDue]
    .map((d) => (d ? daysUntil(d, now.value) : undefined))
    .filter((d): d is number => d !== undefined);
  return candidates.length ? Math.min(...candidates) : undefined;
}

type Highlight = {
  risk: WorkspaceRisk;
  band: RiskBand;
  proximity: Proximity;
  escalate: boolean;
  dueText: string;
};

const highlighted = computed<Highlight[]>(() => {
  const rows = (store.byWorkspace[props.workspaceId] ?? []).filter(isLive);
  const picked = rows
    .map((risk) => {
      const band = bandOf(effectiveExposure(risk));
      const severe = band === 'high' || band === 'extreme';
      const days = urgencyDays(risk);
      // Approaching: within a fortnight, including anything already past its date (days < 0).
      const approaching = days !== undefined && days <= 14;
      return { risk, band, severe, approaching, days };
    })
    .filter((r) => r.severe || r.approaching);
  picked.sort((a, b) => {
    if (a.band !== b.band) return BAND_RANK[b.band] - BAND_RANK[a.band];
    const da = a.days ?? Number.POSITIVE_INFINITY;
    const db = b.days ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return a.risk.code.localeCompare(b.risk.code);
  });
  return picked.slice(0, 6).map((r) => {
    // The date to show is the one that made it urgent: its proximity if set, else the action due.
    const date = r.risk.proximity ?? r.risk.actionDue;
    const l = dueLabel(date, now.value);
    return {
      risk: r.risk,
      band: r.band,
      proximity: proximityOf(r.risk.proximity, now.value),
      escalate: needsEscalation(r.risk),
      dueText: l.params ? t(l.key, l.params, l.params.n) : t(l.key),
    };
  });
});
</script>

<style scoped lang="scss">
.riskw {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  height: 100%;
}

.riskw__note {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}

.riskw__note--error {
  color: var(--k-danger);
}

.riskw__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.riskw__row + .riskw__row {
  border-top: 1px solid var(--k-line);
}

.riskw__link {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--k-sp-2) 0;
  color: inherit;
  text-decoration: none;
}

.riskw__link:hover .riskw__event {
  color: var(--k-accent);
}

.riskw__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.riskw__code {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.riskw__band {
  font-family: var(--k-font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: var(--k-r-sm);
  color: var(--k-on-accent);
  background: var(--k-muted);
}

.riskw__band--medium { background: var(--k-warning); }
.riskw__band--high { background: var(--k-warning); }
.riskw__band--extreme { background: var(--k-danger); }

.riskw__escalate {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--k-danger);
  border: 1px solid var(--k-danger);
  border-radius: var(--k-r-sm);
  padding: 1px 5px;
}

.riskw__event {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.riskw__due {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.riskw__due--immediate,
.riskw__due--passed {
  color: var(--k-warning);
}

.riskw__all {
  margin-top: auto;
  align-self: flex-start;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
  text-decoration: none;
}

.riskw__all:hover {
  text-decoration: underline;
}
</style>
