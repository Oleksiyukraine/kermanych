<template>
  <section class="k-diff" :aria-label="t('kit.diff.fileChanges', { path })">
    <header class="k-diff__head">
      <span class="k-diff__path mono">{{ path }}</span>
      <span class="k-diff__spacer"></span>
      <span v-if="diff?.truncated" class="k-diff__note mono">
        {{ t('kit.diff.truncated', { count: rowCount }) }}
      </span>
      <KIconButton
        v-if="canPlain"
        :title="diffOn ? t('kit.diff.hideDiff') : t('kit.diff.showDiff')"
        :active="diffOn"
        :aria-pressed="diffOn"
        @click="diffOn = !diffOn"
      ><KIcon class="k-diff__icon" name="viewDiff" /></KIconButton>
      <span v-if="canPlain && previewable" class="k-diff__sep" aria-hidden="true"></span>
      <KViewModeToggle v-if="previewable" :model-value="mode" @update:model-value="pickMode" />
      <KIconButton :title="t('kit.diff.collapse')" @click="emit('close')">✕</KIconButton>
    </header>

    <div class="k-diff__panes" :class="`k-diff__panes--${shownMode}`">
      <div v-if="shownMode !== 'preview'" class="k-diff__source">
        <!-- Diff off: the whole current file, highlighted, read through `load`. -->
        <template v-if="!showDiff">
          <div v-if="plainPhase === 'skeleton'" class="k-diff__pad">
            <KSkeleton variant="lines" :rows="6" />
          </div>
          <template v-else-if="plainPhase === 'blank'"></template>
          <p v-else-if="plainError" class="k-diff__msg k-diff__msg--error mono" role="alert">{{ plainError }}</p>
          <p v-else-if="plainBinary" class="k-diff__msg mono">{{ t('kit.diff.binary') }}</p>
          <div v-else class="k-diff__body">
            <div class="k-diff__code mono">
              <div class="k-diff__gutter" aria-hidden="true">{{ lineNumbers }}</div>
              <pre class="k-diff__plain"><code v-if="plainHtml" class="hljs" v-html="plainHtml"></code><code v-else class="hljs">{{ plainText }}</code></pre>
            </div>
          </div>
        </template>
        <p v-else-if="loading" class="k-diff__msg mono">{{ t('kit.diff.loading') }}</p>
        <p v-else-if="error" class="k-diff__msg k-diff__msg--error mono" role="alert">{{ error }}</p>
        <p v-else-if="diff?.binary" class="k-diff__msg mono">{{ t('kit.diff.binary') }}</p>
        <p v-else-if="!diff?.hunks.length" class="k-diff__msg mono">{{ t('kit.diff.noChanges') }}</p>
        <div v-else class="k-diff__body">
          <div class="k-diff__grid mono">
            <!-- The two sections. They are rows of ONE grid, not two panes: shared columns are
                 what keeps a removed line opposite the added line that replaced it, with a
                 single scrollbar for both. -->
            <div class="k-diff__col-head">{{ t('kit.diff.original') }}</div>
            <div class="k-diff__col-head k-diff__col-head--new">{{ t('kit.diff.changes') }}</div>
            <template v-for="(hunk, hi) in diff.hunks" :key="hi">
              <div class="k-diff__hunk">{{ hunk.header }}</div>
              <template v-for="(row, ri) in hunk.rows" :key="`${hi}:${ri}`">
                <div class="k-diff__no">{{ row.old?.no ?? '' }}</div>
                <div
                  class="k-diff__line"
                  :class="{
                    'k-diff__line--del': row.kind === 'del' || row.kind === 'mod',
                    'k-diff__line--void': !row.old,
                  }"
                >{{ row.old?.text ?? '' }}</div>
                <div class="k-diff__no k-diff__no--new">{{ row.new?.no ?? '' }}</div>
                <div
                  class="k-diff__line"
                  :class="{
                    'k-diff__line--add': row.kind === 'add' || row.kind === 'mod',
                    'k-diff__line--void': !row.new,
                  }"
                >{{ row.new?.text ?? '' }}</div>
              </template>
            </template>
          </div>
        </div>
      </div>
      <KDocPreview
        v-if="shownMode !== 'source' && load"
        class="k-diff__preview"
        :path="path"
        :load="load"
        :refresh-key="diff"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
// One changed file, side by side: the original on the left, the session's version on the
// right. The api hands over rows already paired (apps/api/src/worktree/split-diff.ts), so
// this component only paints them — no diffing here.
//
// Fetch state lives in the props rather than in the component: the caller owns the request
// (and its refresh while the agent keeps editing), while the path + collapse control stay
// visible through loading, an error and a binary file alike.
//
// A Markdown/HTML/PDF file also has a rendered form: with `load` (raw bytes of a repo path)
// the header offers source / split / preview (KViewModeToggle), and the preview re-reads
// whenever the caller refreshes the diff.
//
// The diff itself is optional: with `load`, the ± button swaps the paired rows for the whole
// current file, highlighted — the file as it reads now rather than what changed in it.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { useLoadPhase } from '../../composables/useLoadPhase';
import type { FileDiff } from '../../lib/api';
import { diffShown, docPreviewKind, initialViewMode, rememberedViewMode, type ViewMode } from '../../lib/doc-preview';
import KDocPreview from './KDocPreview.vue';
import KIcon from './KIcon.vue';
import KIconButton from './KIconButton.vue';
import KSkeleton from './KSkeleton.vue';
import KViewModeToggle from './KViewModeToggle.vue';

const { t } = useI18n();

const props = defineProps<{
  path: string;
  diff: FileDiff | null;
  loading?: boolean;
  error?: string | null;
  load?: (path: string) => Promise<Blob>;
}>();

const emit = defineEmits<{ close: [] }>();

const previewKind = computed(() => docPreviewKind(props.path));
// A deleted file has no session version left to render: every row is original-only.
const deleted = computed(() => {
  const d = props.diff;
  return !!d && !d.binary && d.hunks.length > 0 && d.hunks.every((h) => h.rows.every((r) => !r.new));
});
const previewable = computed(() => !!props.load && previewKind.value !== null && !deleted.value);
// Per view, seeded from the remembered mode; a pick here becomes the remembered one, so the
// next file (or this one, docked ↔ full screen) opens the same way.
const mode = ref<ViewMode>(initialViewMode(previewKind.value));
watch(previewKind, (k) => { mode.value = initialViewMode(k); });
// Only a click is remembered — not a PDF's automatic fall-back to `preview`.
function pickMode(m: ViewMode): void {
  mode.value = m;
  rememberedViewMode.value = m;
}
const shownMode = computed<ViewMode>(() => (previewable.value ? mode.value : 'source'));

// Diff off needs the file's current text: a binary blob has none and a deleted file has no
// current version, so for those the diff is the only view and the button is not offered.
// The choice itself is shared and remembered (lib/doc-preview.ts), not per file.
const diffOn = diffShown;
const canPlain = computed(() => !!props.load && !props.diff?.binary && !deleted.value);
const showDiff = computed(() => diffOn.value || !canPlain.value);

const plainText = ref('');
const plainBinary = ref(false);
const plainError = ref<string | null>(null);
const plainFor = ref<string | null>(null);
const plainPhase = useLoadPhase(() => plainFor.value !== props.path);
let plainRun = 0;

async function loadPlain(): Promise<void> {
  const load = props.load;
  if (!load) return;
  const run = ++plainRun;
  const path = props.path;
  try {
    const text = await (await load(path)).text();
    if (run !== plainRun) return;
    plainBinary.value = text.slice(0, 8000).includes('\0');
    plainText.value = plainBinary.value ? '' : text;
    plainError.value = null;
  } catch (e) {
    if (run !== plainRun) return;
    // The raw route answers 404 for a file over its 4 MB cap as well as a missing one.
    const msg = e instanceof Error ? e.message : String(e);
    plainError.value = /not found/i.test(msg) ? t('kit.diff.fileUnavailable') : msg;
  } finally {
    if (run === plainRun) plainFor.value = path;
  }
}

// Re-read on every diff refresh, as the preview does: the agent may still be editing. The
// text already on screen stays until the new one lands, so a refresh never blanks the pane.
watch(
  [showDiff, () => props.diff, () => props.path],
  ([on], prev) => {
    if (props.path !== prev?.[2]) plainFor.value = null;
    if (!on) void loadPlain();
  },
  // Immediate: a file opened while the remembered choice is «off» must read its text at once.
  { immediate: true },
);

// highlightAuto, as KFileView does: no extension→language table, and its output is
// HTML-escaped by hljs, so v-html carries no markup the file's own bytes did not.
const plainHtml = computed(() => {
  if (!plainText.value) return '';
  try {
    return hljs.highlightAuto(plainText.value).value;
  } catch {
    return '';
  }
});
const lineNumbers = computed(() => {
  const n = plainText.value.replace(/\n$/, '').split('\n').length;
  return Array.from({ length: n }, (_, i) => i + 1).join('\n');
});

// Only shown next to the truncation note, where "перші N" has to name what is on screen.
const rowCount = computed(() =>
  (props.diff?.hunks ?? []).reduce((n, h) => n + h.rows.length, 0),
);
</script>

<style scoped lang="scss">
.k-diff {
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-bg);
  overflow: hidden;
}

.k-diff__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-1) var(--k-sp-2);
  background: var(--k-surface);
  box-shadow: inset 0 -1px 0 0 var(--k-line);
}
.k-diff__path {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  min-width: 0; // a flex item defaults to its content width — without this a long path
  overflow: hidden; // pushes the collapse control out of the header instead of eliding
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-diff__spacer { flex: 1; }
.k-diff__note {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.k-diff__msg {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-diff__msg--error { color: var(--k-diff-del); }

.k-diff__body {
  max-height: 60vh;
  overflow: auto;
}

.k-diff__icon { --k-icon-size: var(--k-icon-md); }
.k-diff__sep {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--k-line-strong);
}
.k-diff__pad { padding: var(--k-sp-3); }

// Diff off: a gutter and the code side by side, at the diff's 18px rows so the numbers stay
// level with their lines. The gutter sticks to the left edge through a horizontal scroll.
.k-diff__code {
  display: grid;
  grid-template-columns: auto minmax(max-content, 1fr);
  font-size: var(--k-fs-xs);
  line-height: 18px;
  tab-size: 2;
}
.k-diff__gutter {
  position: sticky;
  left: 0;
  padding: 0 var(--k-sp-2);
  white-space: pre;
  text-align: right;
  color: var(--k-faint);
  background: var(--k-bg);
  box-shadow: inset -1px 0 0 0 var(--k-line);
  user-select: none; // keeps line numbers out of a copied selection
}
.k-diff__plain {
  margin: 0;
  padding: 0 var(--k-sp-2);
  font: inherit;

  code {
    background: transparent;
    padding: 0;
    font: inherit;
    white-space: pre;
  }
}

// With a preview on screen the block takes a fixed height: a rendered page or a PDF has no
// natural height of its own to grow to.
.k-diff__panes--split,
.k-diff__panes--preview {
  height: 60vh;
}
.k-diff__panes--split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.k-diff__source {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.k-diff__panes--split .k-diff__body {
  flex: 1;
  min-height: 0;
  max-height: none;
}
.k-diff__panes--split .k-diff__preview {
  box-shadow: inset 1px 0 0 0 var(--k-line-strong);
}

// `max-content` minimums let a long line push the grid wider than the pane (one
// horizontal scrollbar for both halves); the `1fr` maximums keep the two sections equal
// whenever the lines do fit.
.k-diff__grid {
  display: grid;
  grid-template-columns: auto minmax(max-content, 1fr) auto minmax(max-content, 1fr);
  font-size: var(--k-fs-xs);
  tab-size: 2;
}

.k-diff__col-head {
  position: sticky;
  top: 0;
  z-index: 1;
  grid-column: span 2;
  padding: 3px var(--k-sp-2);
  background: var(--k-surface2);
  box-shadow: inset 0 -1px 0 0 var(--k-line);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}
.k-diff__col-head--new { box-shadow: inset 1px 0 0 0 var(--k-line-strong), inset 0 -1px 0 0 var(--k-line); }

.k-diff__hunk {
  grid-column: 1 / -1;
  padding: 2px var(--k-sp-2);
  background: var(--k-surface);
  color: var(--k-faint);
  border-top: 1px solid var(--k-line);
  border-bottom: 1px solid var(--k-line);
}

// A fixed row height is load-bearing: an empty line on both sides would otherwise collapse
// its row and slide the two columns out of step.
.k-diff__no,
.k-diff__line {
  line-height: 18px;
  min-height: 18px;
}
.k-diff__no {
  padding: 0 var(--k-sp-2);
  text-align: right;
  color: var(--k-faint);
  user-select: none; // keeps line numbers out of a copied selection
}
.k-diff__no--new { box-shadow: inset 1px 0 0 0 var(--k-line-strong); }

.k-diff__line {
  padding: 0 var(--k-sp-2);
  color: var(--k-text);
  white-space: pre;
}
.k-diff__line--del { background: color-mix(in srgb, var(--k-diff-del) 18%, transparent); }
.k-diff__line--add { background: color-mix(in srgb, var(--k-diff-add) 18%, transparent); }
// No counterpart on this side. A faint hatch, not a tint: a flat panel reads as an empty
// line of code, while stripes read as "there is nothing here" at a glance.
.k-diff__line--void {
  background: repeating-linear-gradient(135deg, transparent 0 6px, var(--k-line) 6px 7px);
}
</style>
