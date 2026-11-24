<template>
  <!-- omp's «Tool commands» notices as one row: a plug mark and an `MCP` label, then one pill
       per server — a status dot, the name, the tool count. A pill opens its tools below. -->
  <div class="ktc">
    <div class="ktc__line">
      <KIcon name="integrations" class="ktc__icon" />
      <span class="ktc__label">MCP</span>
      <button
        v-for="s in servers"
        :key="s.server"
        type="button"
        class="ktc__pill"
        :class="[`ktc__pill--${s.state}`, { 'ktc__pill--open': opened.has(s.server) }]"
        :aria-expanded="s.tools.length ? opened.has(s.server) : undefined"
        :disabled="!s.tools.length"
        :title="stateLabel(s)"
        @click="toggle(s.server)"
      >
        <span class="ktc__dot" aria-hidden="true" />
        <span class="ktc__name">{{ s.server }}</span>
        <span v-if="s.tools.length" class="ktc__count">{{ s.tools.length }}</span>
      </button>
    </div>

    <!-- The open servers' tools as mono chips; with several open, each list is captioned. -->
    <div v-if="openServers.length" class="ktc__lists">
      <div v-for="s in openServers" :key="s.server" class="ktc__list">
        <span v-if="openServers.length > 1" class="ktc__list-head">{{ s.server }}</span>
        <span v-for="tool in s.tools" :key="tool" class="ktc__chip">{{ tool }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NoticeEntry } from '@kermanych/core';
import KIcon from './KIcon.vue';
import type { ExpandAllCommand } from '../../lib/expand-all';
import { toolCommandServers, type ToolCommandServer } from '../../lib/tool-commands';

const props = defineProps<{ notices: NoticeEntry[]; expandAll: ExpandAllCommand }>();

const { t } = useI18n();

const servers = computed(() => toolCommandServers(props.notices));

// Which servers' tool lists are open. «деталі: розгорнути все» opens every one, and
// «стиснути все» shuts the ones the operator opened by hand, as with the grouped tool rows.
const opened = ref(new Set<string>());
watch(
  () => props.expandAll.seq,
  () => {
    opened.value = props.expandAll.on ? new Set(servers.value.filter((s) => s.tools.length).map((s) => s.server)) : new Set();
  },
  { immediate: true },
);
function toggle(server: string): void {
  const next = new Set(opened.value);
  if (!next.delete(server)) next.add(server);
  opened.value = next;
}
const openServers = computed(() => servers.value.filter((s) => opened.value.has(s.server) && s.tools.length));

// The pill's tooltip: what happened to the server, with the count when there is one.
function stateLabel(s: ToolCommandServer): string {
  const n = s.tools.length;
  if (!n) return t(s.state === 'added' ? 'kit.toolCommands.added' : 'kit.toolCommands.removed');
  return t(s.state === 'added' ? 'kit.toolCommands.addedCount' : 'kit.toolCommands.removedCount', { count: n }, n);
}
</script>

<style scoped lang="scss">
.ktc {
  font-family: var(--k-font-ui);
  font-size: 13px;
  color: var(--k-muted);
}
.ktc__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ktc__icon {
  width: var(--k-icon-sm);
  height: var(--k-icon-sm);
  flex: none;
  color: var(--k-success);
}
.ktc__label {
  font-family: var(--k-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--k-text);
  margin-right: 2px;
}

.ktc__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  font: inherit;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  cursor: pointer;
}
.ktc__pill:disabled { cursor: default; }
.ktc__pill:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
.ktc__pill:not(:disabled):hover,
.ktc__pill--open { border-color: var(--k-success); }
.ktc__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--k-success);
}
.ktc__name { font-family: var(--k-font-mono); font-size: 12px; }
.ktc__count {
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-faint);
}

// An unmounted server reads as gone: dashed outline, grey dot, struck-through name.
.ktc__pill--removed {
  color: var(--k-faint);
  background: transparent;
  border-style: dashed;
}
.ktc__pill--removed .ktc__dot { background: var(--k-faint); }
.ktc__pill--removed .ktc__name { text-decoration: line-through; }

.ktc__lists {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding-left: 12px;
  border-left: 1px solid var(--k-line);
}
.ktc__list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.ktc__list-head {
  margin-right: 2px;
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-faint);
}
.ktc__chip {
  padding: 1px 6px;
  font-family: var(--k-font-mono);
  font-size: 11.5px;
  color: var(--k-muted);
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);
}
</style>
