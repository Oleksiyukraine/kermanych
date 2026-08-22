<template>
  <div>
    <button type="button" class="k-tr" :aria-expanded="open" @click="toggle">
      <span class="k-tr__g" :class="`k-tr__g--${entry.status}`" aria-hidden="true">{{ glyph }}</span>
      <span class="k-tr__t">{{ entry.tool }}</span>
      <span class="k-tr__tg">{{ entry.target ?? '' }}</span>
      <span class="k-tr__st">{{ entry.stat ?? '' }}</span>
      <span class="k-tr__ch" aria-hidden="true">{{ open ? '⌄' : '›' }}</span>
    </button>
    <KToolCard
      v-if="open && shown.length"
      :entry="{ ...entry, truncatedNote: note }"
      :lines="shown"
      :total-lines="total"
      @more="loadFull"
    />
    <div v-else-if="open" class="k-tr__empty mono">{{ note || 'Деталей немає.' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolLine, TranscriptEntry } from '@kermanych/core';
import { api } from '../../lib/api';
import KToolCard from './KToolCard.vue';

const props = defineProps<{ entry: Extract<TranscriptEntry, { kind: 'tool' }>; sessionId: string }>();

const open = ref(false);
const fullLines = ref<ToolLine[] | undefined>(undefined);
const error = ref('');

const glyph = computed(() => (props.entry.status === 'pending' ? '◆' : props.entry.status === 'ok' ? '✓' : '✗'));
const shown = computed(() => fullLines.value ?? props.entry.detail?.lines ?? []);
const total = computed(() => (fullLines.value ? fullLines.value.length : props.entry.detail?.totalLines ?? 0));
const note = computed(() => error.value || (props.entry.detail?.truncatedUpstream ? 'віддано обрізаним' : ''));

function toggle(): void {
  open.value = !open.value;
}

async function loadFull(): Promise<void> {
  try {
    const res = await api.getToolDetail(props.sessionId, props.entry.id);
    fullLines.value = res.lines;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style scoped lang="scss">
.k-tr {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
  font-family: var(--k-font-mono); font-size: 12.5px; line-height: 1.7;
  white-space: nowrap; overflow: hidden; color: var(--k-muted);
}
.k-tr:hover { background: var(--k-surface); }
.k-tr:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
.k-tr__g { flex: none; width: 9px; font-size: 10.5px; }
.k-tr__g--pending { color: var(--k-accent); animation: k-tr-pulse 1.4s ease-in-out infinite; }
.k-tr__g--error { color: var(--k-accent); }
@keyframes k-tr-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
/* Fixed column: this is what stops `bash` from wrapping as `bas`/`h`. */
.k-tr__t { flex: none; width: 44px; color: var(--k-text); }
.k-tr__tg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.k-tr__st { flex: none; font-size: 11.5px; color: var(--k-text); }
.k-tr__ch { flex: none; width: 10px; text-align: right; font-size: 11px; color: var(--k-line-strong); }
.k-tr__empty { margin: 2px 0 8px 17px; font-size: 11.5px; color: var(--k-muted); }
</style>
