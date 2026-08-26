<template>
  <section class="k-diff" :aria-label="`Зміни у файлі ${path}`">
    <header class="k-diff__head">
      <span class="k-diff__path mono">{{ path }}</span>
      <span class="k-diff__spacer"></span>
      <span v-if="diff?.truncated" class="k-diff__note mono">
        завеликий diff — показано перші {{ rowCount }} рядків
      </span>
      <KIconButton title="Згорнути diff" @click="emit('close')">✕</KIconButton>
    </header>

    <p v-if="loading" class="k-diff__msg mono">Готую diff…</p>
    <p v-else-if="error" class="k-diff__msg k-diff__msg--error mono" role="alert">{{ error }}</p>
    <p v-else-if="diff?.binary" class="k-diff__msg mono">Бінарний файл — порядкового diff немає.</p>
    <p v-else-if="!diff?.hunks.length" class="k-diff__msg mono">Цей файл не відрізняється від бази.</p>
    <div v-else class="k-diff__body">
      <div class="k-diff__grid mono">
        <!-- The two sections. They are rows of ONE grid, not two panes: shared columns are
             what keeps a removed line opposite the added line that replaced it, with a
             single scrollbar for both. -->
        <div class="k-diff__col-head">Оригінал</div>
        <div class="k-diff__col-head k-diff__col-head--new">Зміни</div>
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
import { computed } from 'vue';
import type { FileDiff } from '../../lib/api';
import KIconButton from './KIconButton.vue';

const props = defineProps<{
  path: string;
  diff: FileDiff | null;
  loading?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

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
