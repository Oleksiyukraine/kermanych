<template>
  <div>
    <button type="button" class="k-tr" :aria-expanded="open" @click="toggle">
      <span class="k-tr__g" :class="`k-tr__g--${entry.status}`" role="img" :aria-label="statusLabel">{{ glyph }}</span>
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
      :busy="loading"
      @more="loadFull"
    />
    <div v-else-if="open" class="k-tr__empty mono">
      <div v-if="entry.intent" class="k-tr__intent">{{ entry.intent }}</div>
      <div>{{ note || 'Деталей немає.' }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolLine, TranscriptEntry } from '@kermanych/core';
import { api } from '../../lib/api';
import type { ExpandAllCommand } from '../../lib/expand-all';
import KToolCard from './KToolCard.vue';

const props = defineProps<{
  entry: Extract<TranscriptEntry, { kind: 'tool' }>;
  sessionId: string;
  // The detail toolbar's last command. Required rather than optional: a card that
  // silently never hears the toolbar is exactly the defect this prop exists to fix, so a
  // call site that forgets to thread it has to fail the typecheck.
  expandAll: ExpandAllCommand;
}>();

const open = ref(false);
const fullLines = ref<ToolLine[] | undefined>(undefined);
const error = ref('');
const loading = ref(false);

// The log renders its items index-keyed, so one instance is rebound to another call —
// in another session, even. Watch the id, not the object: `transcript_update` rebuilds
// the entry copy-on-write on every patch, and identity would collapse an expanded row
// the moment its tool finishes.
watch(() => props.entry.id, () => {
  // A rebound row is a different call, so its own toggle is forgotten — but the last
  // block-wide command still applies, or `розгорнути все` would silently lapse as the
  // log grows.
  open.value = props.expandAll.on;
  fullLines.value = undefined;
  error.value = '';
  loading.value = false;
});

// The toolbar is a command, not an override: every press writes the block-wide answer
// into this row's own state, so `розгорнути все` really opens the card and `стиснути все`
// really closes it — including a card the operator opened by hand — and the row stays
// individually toggleable afterwards in either position. Keyed on `seq`, not `on`, so a
// press that re-asserts the mode already set still acts, and `immediate` covers a row
// that mounts while the toolbar is already expanded.
watch(() => props.expandAll.seq, () => { open.value = props.expandAll.on; }, { immediate: true });

const glyph = computed(() => (props.entry.status === 'pending' ? '◆' : props.entry.status === 'ok' ? '✓' : '✗'));
// The glyph alone reaches assistive technology as nothing, and no visible word follows it.
const statusLabel = computed(() =>
  props.entry.status === 'pending' ? 'виконується' : props.entry.status === 'ok' ? 'завершено' : 'помилка',
);
const shown = computed(() => fullLines.value ?? props.entry.detail?.lines ?? []);
const total = computed(() => (fullLines.value ? fullLines.value.length : props.entry.detail?.totalLines ?? 0));
const note = computed(() => error.value || (props.entry.detail?.truncatedUpstream ? 'віддано обрізаним' : ''));

function toggle(): void {
  open.value = !open.value;
}

async function loadFull(): Promise<void> {
  // Overlapping fetches would race to assign `fullLines`; a stale failure would otherwise
  // pin the accent note for the row's lifetime and mask the truncation warning.
  if (loading.value) return;
  const id = props.entry.id;
  loading.value = true;
  error.value = '';
  try {
    const res = await api.getToolDetail(props.sessionId, id);
    // The instance may have been rebound mid-flight; that call's output is not this row's.
    if (props.entry.id !== id) return;
    fullLines.value = res.lines;
  } catch (e) {
    if (props.entry.id === id) error.value = (e as Error).message;
  } finally {
    if (props.entry.id === id) loading.value = false;
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
/* Fixed column: this is what stops `bash` from wrapping as `bas`/`h`. 60px is eight
   characters at 12.5px mono, covering the builtin toolset up to `ast_edit`; the
   ellipsis is the backstop for longer outliers like `web_search`. */
.k-tr__t { flex: none; width: 60px; overflow: hidden; text-overflow: ellipsis; color: var(--k-text); }
.k-tr__tg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
/* Capped so the stat ellipsises instead of starving the target, which is the only
   shrinkable cell, at the panel's 360px minimum. */
.k-tr__st { flex: 0 1 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; color: var(--k-text); }
.k-tr__ch { flex: none; width: 10px; text-align: right; font-size: 11px; color: var(--k-line-strong); }
.k-tr__empty { margin: 2px 0 8px 17px; font-size: 11.5px; color: var(--k-muted); }
/* Same treatment the card gives the intent, so the pending row reads identically. */
.k-tr__intent { font-family: var(--k-font-ui); font-size: 12px; font-style: italic; }
</style>
