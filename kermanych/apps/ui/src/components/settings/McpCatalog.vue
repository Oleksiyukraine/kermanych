<template>
  <div class="mcpcat">
    <p class="mcpcat__lead">{{ t('aiTeam.mcp.catalog.lead') }}</p>
    <input
      ref="searchEl"
      v-model="query"
      class="mcpcat__search"
      type="search"
      :placeholder="t('aiTeam.mcp.catalog.search')"
      :aria-label="t('aiTeam.mcp.catalog.search')"
    />

    <button type="button" class="mcpcat__card mcpcat__card--custom" @click="emit('pick', undefined)">
      <span class="mcpcat__title">{{ t('aiTeam.mcp.catalog.custom') }}</span>
      <span class="mcpcat__about">{{ t('aiTeam.mcp.catalog.customHint') }}</span>
    </button>

    <section v-for="g in groups" :key="g.key" class="mcpcat__group">
      <h3 class="mcpcat__group-title">{{ t('aiTeam.mcp.catalog.groups.' + g.key) }}</h3>
      <div class="mcpcat__grid">
        <!-- A name already in `.mcp.json` cannot be added again (the api refuses it); the card
             says so instead of failing at the save. -->
        <button
          v-for="e in g.entries"
          :key="e.id"
          type="button"
          class="mcpcat__card"
          :disabled="existing.includes(e.name)"
          @click="emit('pick', e)"
        >
          <span class="mcpcat__head">
            <span class="mcpcat__title">{{ e.title }}</span>
            <KTag v-if="existing.includes(e.name)">{{ t('aiTeam.mcp.catalog.added') }}</KTag>
            <span v-else class="mcpcat__auth" :class="'mcpcat__auth--' + e.auth">{{ t('aiTeam.mcp.catalog.auth.' + e.auth) }}</span>
          </span>
          <span class="mcpcat__about">{{ about(e) }}</span>
        </button>
      </div>
    </section>

    <p v-if="!groups.length" class="mcpcat__nothing">{{ t('aiTeam.mcp.catalog.nothing') }}</p>
  </div>
</template>

<script setup lang="ts">
// The catalog step of «Додати сервер» (docs/specs/2026-11-16-mcp-catalog.md): popular services
// by what they are for, a search, and «Власний сервер» for anything else.
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MCP_CATALOG_GROUPS, mcpCatalogSearch, type McpCatalogEntry } from '../../lib/mcp-catalog';
import KTag from 'components/kit/KTag.vue';

defineProps<{ existing: string[] }>();
const emit = defineEmits<{ pick: [entry: McpCatalogEntry | undefined] }>();
const { t } = useI18n();

const query = ref('');
const searchEl = ref<HTMLInputElement>();
onMounted(() => searchEl.value?.focus());

const about = (e: McpCatalogEntry) => t('aiTeam.mcp.catalog.about.' + e.id);

const groups = computed(() => {
  const found = mcpCatalogSearch(query.value, about);
  return MCP_CATALOG_GROUPS.map((key) => ({ key, entries: found.filter((e) => e.group === key) })).filter((g) => g.entries.length);
});
</script>

<style scoped lang="scss">
.mcpcat {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.mcpcat__lead {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}

.mcpcat__search {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  padding: 8px 11px;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    outline: none;
    border-color: var(--k-accent);
  }
}

.mcpcat__group {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.mcpcat__group-title {
  margin: 0;
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
  color: var(--k-faint);
}

.mcpcat__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: var(--k-sp-2);
}

.mcpcat__card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-family: var(--k-font-ui);
  text-align: left;
  color: var(--k-text);
  background: var(--k-bg);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;

  &:hover:not(:disabled) {
    border-color: var(--k-line-strong);
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }

  &--custom {
    border-style: dashed;
    border-color: var(--k-line-strong);
  }
}

.mcpcat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
}

.mcpcat__title {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.mcpcat__about {
  font-size: var(--k-fs-xs);
  line-height: 1.45;
  color: var(--k-muted);
}

.mcpcat__auth {
  flex: none;
  font-size: 11px;
  color: var(--k-faint);

  &--key {
    color: var(--k-warning);
  }
}

.mcpcat__nothing {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
