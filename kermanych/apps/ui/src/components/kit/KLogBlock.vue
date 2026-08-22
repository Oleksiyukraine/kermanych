<template>
  <!-- `turn` is ledger data for block summaries, not a row: it renders nothing at
       all, wrapper included, so it leaves no phantom gap in the log. -->
  <div v-if="entry.kind !== 'turn'" class="k-log" :class="`k-log--${entry.kind}`">
    <KToolRow v-if="entry.kind === 'tool'" :entry="entry" :session-id="sessionId" :expand-all="expandAll" />

    <!-- assistant_text — Markdown-rendered prose, UI font -->
    <div v-else-if="entry.kind === 'assistant_text'" class="k-log__markdown" v-html="renderedText" />

    <!-- user_text — the operator's own message: prompt text + any attached images -->
    <template v-else-if="entry.kind === 'user_text'">
      <div v-if="entry.text" class="k-log__user">{{ entry.text }}</div>
      <div v-if="entry.images?.length" class="k-log__user-images">
        <img
          v-for="(src, i) in entry.images"
          :key="i"
          :src="src"
          class="k-log__user-img"
          alt="вкладення"
        />
      </div>
    </template>

    <!-- assistant_thinking — a chip carrying duration and token cost; expand to read the chain -->
    <div v-else-if="entry.kind === 'assistant_thinking'" class="k-log__reason">
      <button
        type="button"
        class="k-log__reason-toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="k-log__reason-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        {{ chip }}
      </button>
      <div v-if="open" class="k-log__reason-body k-log__markdown" v-html="renderedThinking" />
    </div>

    <!-- notice — muted by default; warn and error lift into the accent -->
    <div v-else-if="entry.kind === 'notice'" class="k-log__notice" :class="`k-log__notice--${entry.level}`">
      {{ entry.text }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TranscriptEntry } from '@kermanych/core';
import { renderMarkdown } from '../../lib/markdown';
import type { ExpandAllCommand } from '../../lib/expand-all';
import KToolRow from './KToolRow.vue';

// One transcript block. Tool rows delegate to KToolRow; `turn` entries are ledger
// data for block summaries and deliberately render nothing.
const props = defineProps<{ entry: TranscriptEntry; sessionId: string; expandAll: ExpandAllCommand }>();

// assistant_text renders as Markdown (headings, lists, code, links). Output is a
// controlled tag set (html:false), safe for v-html.
const renderedText = computed(() =>
  props.entry.kind === 'assistant_text' ? renderMarkdown(props.entry.text) : '',
);

// Reasoning is collapsed by default; expand to read the full chain. The detail toolbar
// reaches it too — `деталі: розгорнути все` that left every reasoning chain shut would be
// showing the chips and hiding the details they label, and `згорнути все` has to be able
// to undo a chain the operator opened by hand or the pair is not symmetric. Keyed on
// `seq` so a press that re-asserts the current mode still acts.
const open = ref(false);
watch(() => props.entry, () => { open.value = props.expandAll.on; });
watch(() => props.expandAll.seq, () => { open.value = props.expandAll.on; }, { immediate: true });

const renderedThinking = computed(() =>
  props.entry.kind === 'assistant_thinking' ? renderMarkdown(props.entry.text) : '',
);

// The chip carries the two facts that answer "is it alive and what did it cost".
// Missing fields drop out entirely rather than leaving dangling separators.
const chip = computed(() => {
  if (props.entry.kind !== 'assistant_thinking') return '';
  // Sub-second reasoning reads `<1 с`, the same floor marker the block summary uses: a clamp
  // to `1 с` states a duration the agent did not spend, and `0 с` reads as broken.
  const ms = props.entry.ms;
  const msLabel = !ms ? '' : ms < 1000 ? '<1 с' : `${Math.round(ms / 1000)} с`;
  const tok = props.entry.tokens;
  const tokLabel = tok === undefined ? '' : tok >= 1000 ? `${(tok / 1000).toFixed(1)}k ток` : `${tok} ток`;
  // `думав` is the label, not a metric: the dot only ever separates two metrics,
  // so a missing ms or tokens leaves no dangling separator behind.
  const parts = [msLabel, tokLabel].filter(Boolean);
  return parts.length ? `думав ${parts.join(' · ')}` : 'думав';
});
</script>

<style scoped lang="scss">
.k-log {
  font-family: var(--k-font-mono);
  font-size: 12.5px;
  line-height: 1.5;
}

.k-log + .k-log {
  margin-top: 10px;
}

// assistant reasoning — a muted, collapsed disclosure chip; expanded body reuses
// the Markdown prose styles, dimmed.
.k-log__reason { font-family: var(--k-font-ui); }
.k-log__reason-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: none;
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-style: italic;
  color: var(--k-muted);
  cursor: pointer;
}
.k-log__reason-toggle:hover { color: var(--k-text); }
.k-log__reason-toggle:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
.k-log__reason-caret { font-size: 10px; font-style: normal; }
.k-log__reason-body {
  margin-top: 6px;
  padding-left: 14px;
  border-left: 1px solid var(--k-line);
  color: var(--k-muted);
}

.k-log__notice {
  font-size: 12.5px;
  color: var(--k-muted);
  white-space: pre-wrap;
}

// Three levels off a four-colour palette: info stays muted, warn lifts to full text
// weight, error takes the accent — which the design rules reserve for errors.
.k-log__notice--warn { color: var(--k-text); font-weight: 500; }
.k-log__notice--error { color: var(--k-accent); font-weight: 500; }

// user_text — the operator's own message: UI font, neutral left strip + surface.
.k-log__user {
  font-family: var(--k-font-ui);
  font-size: 14px;
  line-height: 1.6;
  color: var(--k-text);
  padding: 6px 10px;
  background: var(--k-surface);
  border-left: 2px solid var(--k-line-strong);
  white-space: pre-wrap;
  word-break: break-word;
}

.k-log__user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.k-log__user-img {
  display: block;
  max-width: 220px;
  max-height: 220px;
  border: 1px solid var(--k-line-strong);
}
</style>
