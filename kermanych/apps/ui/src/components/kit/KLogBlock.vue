<template>
  <div class="k-log" :class="`k-log--${entry.kind}`">
    <!-- tool_call — muted mono, diamond prefix -->
    <template v-if="entry.kind === 'tool_call'">
      <div class="k-log__row k-log__row--tool">
        <span class="k-log__glyph" aria-hidden="true">◆</span>
        <span class="k-log__tool">{{ entry.tool }}</span>
        <span v-if="head" class="k-log__summary">{{ head }}</span>
      </div>
      <div
        v-for="(line, i) in body"
        :key="i"
        class="k-log__body"
        :class="{ 'k-log__diff': line.diff, [`k-log__diff--${line.sign}`]: line.diff }"
      >{{ line.text }}</div>
    </template>

    <!-- tool_result — pass/fail glyph + tool -->
    <template v-else-if="entry.kind === 'tool_result'">
      <div class="k-log__row k-log__row--result">
        <span class="k-log__glyph" aria-hidden="true">{{ entry.ok ? '✓' : '✗' }}</span>
        <span class="k-log__tool">{{ entry.tool }}</span>
        <span v-if="head" class="k-log__summary">{{ head }}</span>
      </div>
      <div
        v-for="(line, i) in body"
        :key="i"
        class="k-log__body"
        :class="{ 'k-log__diff': line.diff, [`k-log__diff--${line.sign}`]: line.diff }"
      >{{ line.text }}</div>
    </template>

    <!-- assistant_text — Markdown-rendered prose, UI font -->
    <div
      v-else-if="entry.kind === 'assistant_text'"
      class="k-log__markdown"
      v-html="renderedText"
    />

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

    <!-- assistant_thinking — collapsed reasoning; expand to read the full chain -->
    <div v-else-if="entry.kind === 'assistant_thinking'" class="k-log__reason">
      <button
        type="button"
        class="k-log__reason-toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="k-log__reason-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        Думаю
      </button>
      <div v-if="open" class="k-log__reason-body k-log__markdown" v-html="renderedThinking" />
    </div>

    <!-- notice — muted -->
    <div v-else class="k-log__notice">{{ entry.text }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TranscriptEntry } from '@kermanych/core';
import { renderMarkdown } from '../../lib/markdown';

// A single transcript block (design-system section 06). Every kind is flush-left;
// all machine text is mono, only assistant prose uses the UI font. diff lines
// (leading + / -) get a 2px green strip and a 7% accent tint — the sole use of
// green, per the design rules.
const props = defineProps<{ entry: TranscriptEntry }>();

type Line = { text: string; diff: boolean; sign: 'add' | 'del' };

function classify(raw: string, allowDiff: boolean): Line {
  if (!allowDiff) return { text: raw, diff: false, sign: 'add' };
  const trimmed = raw.replace(/^\s+/, '');
  const add = /^\+(?!\+)/.test(trimmed);
  const del = /^-(?!-)/.test(trimmed);
  return { text: raw, diff: add || del, sign: del ? 'del' : 'add' };
}

function toLines(src: string | undefined, allowDiff: boolean): Line[] {
  if (!src) return [];
  return src.split('\n').map((line) => classify(line, allowDiff));
}

// First line of a tool summary sits inline with the tool name; any remaining
// lines (typically a diff hunk) render below as body lines.
const head = computed(() => {
  if (props.entry.kind === 'tool_call' || props.entry.kind === 'tool_result') {
    return (props.entry.summary ?? '').split('\n')[0] ?? '';
  }
  return '';
});

// Diff striping (green strip + accent tint) is reserved for real diff/tool
// output. Assistant prose is Markdown-rendered separately (see renderedText).
const body = computed<Line[]>(() => {
  if (props.entry.kind === 'tool_call' || props.entry.kind === 'tool_result') {
    return toLines(props.entry.summary, true).slice(1);
  }
  return [];
});

// assistant_text renders as Markdown (headings, lists, code, links). Output is a
// controlled tag set (html:false), safe for v-html.
const renderedText = computed(() =>
  props.entry.kind === 'assistant_text' ? renderMarkdown(props.entry.text) : '',
);

// Reasoning is collapsed by default; expand to read the full chain.
const open = ref(false);
watch(() => props.entry, () => { open.value = false; });
const renderedThinking = computed(() =>
  props.entry.kind === 'assistant_thinking' ? renderMarkdown(props.entry.text) : '',
);
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

.k-log__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.k-log__glyph {
  flex: none;
  font-size: 11px;
}

// tool_call — everything muted, diamond marker.
.k-log__row--tool {
  color: var(--k-muted);
}

// tool_result — glyph + tool stay muted, the summary reads at text weight.
.k-log__row--result {
  color: var(--k-muted);

  .k-log__summary {
    color: var(--k-text);
  }
}

.k-log__tool {
  color: var(--k-text);
}

.k-log__row--tool .k-log__tool {
  color: var(--k-muted);
}

.k-log__summary {
  color: var(--k-muted);
}

.k-log__body {
  margin-top: 3px;
  padding-left: 20px;
  color: var(--k-text);
  white-space: pre-wrap;
  word-break: break-word;
}

// assistant reasoning — a muted, collapsed disclosure ("Думаю"); expanded body
// reuses the Markdown prose styles, dimmed.
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

// diff — the one place green appears: 2px strip + 7% accent tint.
.k-log__diff {
  font-family: var(--k-font-mono);
  font-size: 12.5px;
  padding: 3px 12px;
  margin-left: 0;
  border-left: 2px solid var(--k-diff);
  background: color-mix(in srgb, var(--k-accent) 7%, transparent);
  color: var(--k-diff);
}

.k-log__body.k-log__diff {
  padding-left: 12px;
}

.k-log__diff--del {
  opacity: 0.85;
}

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
