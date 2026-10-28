<template>
  <!-- Over the folding cap: the one-block render the viewers always had, no per-line rows. -->
  <pre v-if="tooLong" class="k-code k-code--plain mono"><code v-if="html" class="hljs" v-html="html"></code><code v-else class="hljs">{{ text }}</code></pre>
  <div v-else class="k-code hljs mono" :class="{ 'k-code--foldable': regions.size > 0 }">
    <div v-for="row in rows" :key="row" class="k-code__row">
      <span class="k-code__gutter">
        <span class="k-code__no">{{ row + 1 }}</span>
        <button
          v-if="regions.has(row)"
          type="button"
          class="k-code__fold"
          :class="{ 'k-code__fold--closed': folded.has(row) }"
          :aria-expanded="!folded.has(row)"
          :aria-label="folded.has(row) ? t('kit.code.unfold') : t('kit.code.fold')"
          @click="toggle(row)"
        ><KIcon :name="folded.has(row) ? 'chevronRight' : 'chevronDown'" /></button>
        <span v-else-if="regions.size > 0" class="k-code__fold-pad"></span>
      </span>
      <span v-if="folded.has(row) && regions.get(row)" class="k-code__text"><span v-html="foldHead(row)"></span><button
        type="button"
        class="k-code__chip"
        :aria-label="t('kit.code.unfold')"
        @click="toggle(row)"
      >{{ foldLabel(row) }}</button><span v-html="foldTail(row)"></span></span>
      <!-- hljs escapes the file's text, so each line's HTML is its own span markup only. -->
      <span v-else class="k-code__text" v-html="lineHtml[row]"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
// A whole file as code: line numbers, highlight.js colours, and — for JSON, JS/TS, YAML and
// the like (lib/code-folding.ts) — a chevron beside every line that opens a block, which
// folds it to one line: `"packages": { 1 key },`. The chip on a folded line unfolds it too.
//
// The language comes from the extension when highlight.js knows it, and from highlightAuto
// otherwise. Each line is its own row so a fold can drop rows; past FOLD_MAX_LINES that many
// rows would cost more than folding is worth, and the file renders as one block instead.
//
// Folds are kept by start line while the same file re-renders (an agent still editing it),
// and dropped when the path changes.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import {
  extOf,
  foldRegions,
  isJsonPath,
  splitHighlightedLines,
  visibleLines,
  type FoldRegion,
} from '../../lib/code-folding';
import KIcon from './KIcon.vue';

// Each row is ~5 elements and a v-html parse, built on every open and refresh: 5k lines is
// ~25k nodes, about the most a viewer should build up front. Longer files (lockfiles, dumps)
// render as one block — no line numbers or folds, but no stall either.
const FOLD_MAX_LINES = 5_000;

const props = defineProps<{ path: string; text: string }>();

const { t } = useI18n();

const language = computed(() => {
  const ext = extOf(props.path);
  return ext && hljs.getLanguage(ext) ? ext : null;
});

function highlight(src: string, auto: boolean): string {
  if (!src) return '';
  try {
    if (language.value) return hljs.highlight(src, { language: language.value, ignoreIllegals: true }).value;
    return auto ? hljs.highlightAuto(src).value : hljs.highlight(src, { language: 'plaintext' }).value;
  } catch {
    return '';
  }
}

const html = computed(() => highlight(props.text, true));

// A trailing newline ends the last line; it does not start an empty one.
const lines = computed(() => {
  const all = props.text.split('\n');
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  return all;
});
const tooLong = computed(() => lines.value.length > FOLD_MAX_LINES);

const lineHtml = computed(() => {
  const out = html.value
    ? splitHighlightedLines(html.value)
    : lines.value.map((l) => hljs.highlight(l, { language: 'plaintext' }).value);
  return out.slice(0, lines.value.length);
});

const regions = computed<Map<number, FoldRegion>>(() =>
  tooLong.value ? new Map() : foldRegions(props.path, lines.value),
);

const folded = ref(new Set<number>());
watch(() => props.path, () => { folded.value = new Set(); });

const rows = computed(() => visibleLines(lines.value.length, regions.value, folded.value));

function toggle(row: number): void {
  const next = new Set(folded.value);
  if (next.has(row)) next.delete(row);
  else next.add(row);
  folded.value = next;
}

// The folded line: what stands before the opener, re-highlighted on its own (one line is
// cheap, and only folded lines pay it) …
function foldHead(row: number): string {
  const r = regions.value.get(row);
  if (!r || r.openCol === undefined) return lineHtml.value[row] ?? '';
  return highlight(lines.value[row]!.slice(0, r.openCol), false);
}

// … the chip …
function foldLabel(row: number): string {
  const r = regions.value.get(row);
  if (!r?.open) return '⋯';
  const close = r.open === '{' ? '}' : r.open === '[' ? ']' : ')';
  if (isJsonPath(props.path) && r.open !== '(') {
    const n = r.items ?? 0;
    return `${r.open} ${r.open === '{' ? t('kit.code.keys', { n }, n) : t('kit.code.items', { n }, n)} ${close}`;
  }
  return `${r.open}…${close}`;
}

// … and what follows the closer on the block's last line (`,`, `);`).
function foldTail(row: number): string {
  const r = regions.value.get(row);
  if (!r || r.closeCol === undefined) return '';
  return highlight(lines.value[r.end]!.slice(r.closeCol + 1), false);
}
</script>

<style scoped lang="scss">
.k-code {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 18px;
  tab-size: 2;
  background: transparent;
  padding: 0;
}
.k-code--plain {
  padding: 0 var(--k-sp-2);

  code {
    background: transparent;
    padding: 0;
    white-space: pre;
  }
}

// Rows widen together to the longest line (one horizontal scrollbar on the caller's scroller);
// `content-visibility` lets the browser skip laying out rows far off screen.
.k-code:not(.k-code--plain) {
  width: max-content;
  min-width: 100%;
}
.k-code__row {
  display: flex;
  min-height: 18px;
  content-visibility: auto;
  contain-intrinsic-size: auto 18px;
}

// Numbers and chevrons stay put through a horizontal scroll.
.k-code__gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  flex: none;
  background: var(--k-bg);
  box-shadow: inset -1px 0 0 0 var(--k-line);
  user-select: none; // keeps line numbers out of a copied selection
}
.k-code__no {
  min-width: 3ch;
  padding: 0 var(--k-sp-2);
  text-align: right;
  color: var(--k-faint);
}
.k-code__fold,
.k-code__fold-pad {
  width: 16px;
  height: 18px;
  margin-right: 4px;
  flex: none;
}
.k-code__fold {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--k-faint);
  cursor: pointer;
  --k-icon-size: var(--k-icon-xs);
  // An open block's chevron is quiet until the pointer is over the code, as in an IDE; a
  // folded one always shows, since it marks hidden lines.
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;

  &:hover { color: var(--k-text); }
  &:focus-visible {
    opacity: 1;
    outline: 1px solid var(--k-accent);
  }
}
.k-code:hover .k-code__fold,
.k-code__fold--closed {
  opacity: 1;
}

.k-code__text {
  padding: 0 var(--k-sp-2);
  white-space: pre;
  color: var(--k-text);
}
.k-code__chip {
  margin: 0 1px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--k-r-sm);
  background: var(--k-surface2);
  color: var(--k-muted);
  font: inherit;
  line-height: 16px;
  cursor: pointer;

  &:hover { color: var(--k-text); }
  &:focus-visible { outline: 1px solid var(--k-accent); }
}
</style>
