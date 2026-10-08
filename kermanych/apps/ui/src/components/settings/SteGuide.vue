<template>
  <section class="ste" :aria-label="t('settings.language.ste.title')">
    <p class="ste__title">{{ t('settings.language.ste.title') }}</p>
    <p class="ste__lead">{{ t('settings.language.ste.lead') }}</p>
    <KTable :columns="columns" :rows="rows" :row-key="(row) => row.id" />
    <p class="ste__note">{{ t('settings.language.ste.guard') }}</p>
    <p class="ste__note">{{ t('settings.language.ste.scope') }}</p>
    <p class="ste__note">
      {{ t('settings.language.ste.source') }}
      <a class="ste__link" href="https://www.asd-ste100.org/" target="_blank" rel="noopener noreferrer">asd-ste100.org ↗</a>
    </p>
  </section>
</template>

<script setup lang="ts">
// What the three «English — ASD-STE100» entries of the agent-language picker mean, shown under
// the picker before the choice is made (spec: docs/specs/2026-10-08-agent-language-ste.md). The
// table IS core's STE_RULES — the matrix the agent's directive is built from — so the page cannot
// promise a rule the agent does not receive. Only the human-facing wording lives in i18n.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { STE_LEVELS, STE_RULES, type SteLevel, type SteRule } from '@kermanych/core';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';

const { t } = useI18n();

// "100" is the specification's own number (ASD-STE100), not a share; the softer levels read as
// a share of it, exactly as the picker labels them.
const columns = computed<KTableColumn[]>(() => [
  { key: 'rule', label: t('settings.language.ste.colRule') },
  ...STE_LEVELS.map((level) => ({
    key: String(level),
    label: level === 100 ? '100' : `${level}%`,
    align: 'center' as const,
    width: '96px',
  })),
]);

function mark(rule: SteRule, level: SteLevel): string {
  const cell = rule.at[level];
  if (cell === 'on') return '✓';
  if (cell === 'off') return '—';
  return t(`settings.language.ste.soft.${rule.id}`);
}

const rows = computed(() =>
  STE_RULES.map((rule) => ({
    id: rule.id,
    rule: t(`settings.language.ste.rules.${rule.id}`),
    ...Object.fromEntries(STE_LEVELS.map((level) => [String(level), mark(rule, level)])),
  })),
);
</script>

<style scoped lang="scss">
.ste {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

// Same type as the pane's own group labels (SettingsPage `set__label`), so the block reads as one
// more group of the form rather than a foreign panel.
.ste__title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.ste__lead,
.ste__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

.ste__lead {
  color: var(--k-muted);
}

.ste__note {
  color: var(--k-faint);
}

.ste__link {
  color: var(--k-accent);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
