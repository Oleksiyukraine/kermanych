<script setup lang="ts">
// One shell's screen: an xterm.js instance attached to a terminal the api runs
// (stores/terminal.ts). The view owns nothing but pixels — closing it detaches, the shell
// keeps running, and the next view to attach repaints from the api's replay.
//
// ⌘F (Ctrl+F off macOS, where Ctrl+F stays the shell's forward-char) or the parent's
// magnifier (`toggleFind`) opens a find bar over the screen and its scrollback: matches are
// marked in amber like a file viewer's, Enter / Shift+Enter step, Esc closes the bar and hands
// the keyboard back to the shell.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_SCROLLBACK } from '@kermanych/core';
import { useTerminal } from 'stores/terminal';
import { theme } from '../../lib/theme';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KFindBar from './KFindBar.vue';
import KSkeleton from './KSkeleton.vue';

const props = defineProps<{ terminalId: string; active: boolean }>();

const { t } = useI18n();
const store = useTerminal();
const frame = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let search: SearchAddon | undefined;
let observer: ResizeObserver | undefined;
// False until the api's attach replay (or the first streamed chunk) paints the screen: an
// empty black box until then reads as a dead shell.
const replayed = ref(false);
const phase = useLoadPhase(() => !replayed.value);

// Colours come from the design tokens, so the terminal follows the app theme. The ANSI
// palette stays xterm's; minimumContrastRatio keeps it legible on the light background.
function tokenTheme(el: HTMLElement): ITheme {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--k-bg'),
    foreground: v('--k-text'),
    cursor: v('--k-accent'),
    cursorAccent: v('--k-bg'),
    selectionBackground: v('--k-line-strong'),
  };
}

// ── Find ─────────────────────────────────────────────────────────────────
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
// Past this many matches the addon stops marking them and reports none as current.
const HIGHLIGHT_LIMIT = 1000;
const findOpen = ref(false);
const findQuery = ref('');
const findCase = ref(false);
const findWord = ref(false);
const results = ref({ index: -1, count: 0 });

const findCount = computed(() => {
  if (!findQuery.value) return '';
  const { index, count } = results.value;
  if (count === 0) return t('kit.fileView.find.none');
  const more = count >= HIGHLIGHT_LIMIT ? '+' : '';
  return index < 0 ? `${count}${more}` : `${index + 1} / ${count}${more}`;
});

// Decorations take `#RRGGBB` only, so the amber of KCodeView's marks (the warning token over
// the background at 28% / 65%) is mixed here rather than with color-mix().
function mixHex(fg: string, bg: string, weight: number): string {
  const rgb = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const a = rgb(fg);
  const b = rgb(bg);
  if ([...a, ...b].some(Number.isNaN)) return fg;
  return `#${a.map((c, i) => Math.round(c * weight + b[i]! * (1 - weight)).toString(16).padStart(2, '0')).join('')}`;
}

function searchOptions(incremental: boolean): ISearchOptions {
  const css = getComputedStyle(frame.value ?? document.documentElement);
  const warning = css.getPropertyValue('--k-warning').trim() || '#febc2e';
  const bg = css.getPropertyValue('--k-bg').trim() || '#000000';
  return {
    caseSensitive: findCase.value,
    wholeWord: findWord.value,
    incremental,
    decorations: {
      matchBackground: mixHex(warning, bg, 0.28),
      activeMatchBackground: mixHex(warning, bg, 0.65),
      matchOverviewRuler: warning,
      activeMatchColorOverviewRuler: warning,
    },
  };
}

// Every edit (and a toggle) searches anew from where the current match stands, so typing a
// longer query keeps the place; an emptied field clears the marks.
function runFind(): void {
  if (!search) return;
  if (!findQuery.value) {
    search.clearDecorations();
    results.value = { index: -1, count: 0 };
    return;
  }
  search.findNext(findQuery.value, searchOptions(true));
}
watch([findQuery, findCase, findWord], () => {
  if (findOpen.value) runFind();
});

function findStep(forward: boolean): void {
  if (!search || !findQuery.value) return;
  if (forward) search.findNext(findQuery.value, searchOptions(false));
  else search.findPrevious(findQuery.value, searchOptions(false));
}

async function openFind(): Promise<void> {
  const reopened = !findOpen.value;
  findOpen.value = true;
  // Reopened with the last query still in the field: its marks come back with it.
  if (reopened && findQuery.value) runFind();
  await nextTick();
  const input = frame.value?.querySelector<HTMLInputElement>('.k-find-bar__input');
  input?.focus();
  input?.select();
}
function closeFind(): void {
  findOpen.value = false;
  search?.clearDecorations();
  term?.clearSelection();
  term?.focus();
}
function toggleFind(): void {
  if (findOpen.value) closeFind();
  else void openFind();
}
defineExpose({ toggleFind, findOpen });

// ⌘F / Ctrl+F from the shell's keyboard: stopped here, so the session browser beside the Лог
// does not open its own find bar as well. By key code, so a Ukrainian layout works too.
function isFindKey(e: KeyboardEvent): boolean {
  return e.code === 'KeyF' && (MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
}

// A hidden tab has no box; fitting it would size the shell to zero columns.
function refit(): void {
  if (!term || !fit || !host.value?.clientWidth || !host.value.clientHeight) return;
  fit.fit();
}

onMounted(() => {
  const el = host.value!;
  term = new Terminal({
    fontFamily: getComputedStyle(el).getPropertyValue('--k-font-mono').trim() || 'monospace',
    fontSize: 12,
    cursorBlink: true,
    scrollback: TERMINAL_SCROLLBACK,
    minimumContrastRatio: 4.5,
    theme: tokenTheme(el),
    // The search addon marks matches with decorations, still xterm's proposed API.
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
  term.loadAddon(search);
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    results.value = { index: resultIndex, count: resultCount };
  });
  // Ctrl+` toggles the panel (MainLayout) — let it through to the window instead of
  // sending it to the shell. ⌘F / Ctrl+F opens find instead of reaching the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (isFindKey(e)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        e.stopPropagation();
        void openFind();
      }
      return false;
    }
    return !(e.ctrlKey && e.code === 'Backquote');
  });
  term.open(el);
  term.onData((data) => store.input(props.terminalId, data));
  term.onResize(({ cols, rows }) => store.resize(props.terminalId, cols, rows));
  refit();
  observer = new ResizeObserver(() => refit());
  observer.observe(el);
  // The mono webfont may land after the first measure, which would leave the grid sized
  // for the fallback font's cell.
  void document.fonts?.ready.then(() => refit());

  store.attach(props.terminalId, {
    reset(replay) {
      term?.reset();
      if (replay) term?.write(replay);
      replayed.value = true;
    },
    data(chunk) {
      term?.write(chunk);
      replayed.value = true;
    },
  });
  // The shell was started at a guessed size; tell it the real one even if fit changed nothing.
  store.resize(props.terminalId, term.cols, term.rows);
  if (props.active) term.focus();
});

watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await nextTick();
    refit();
    term?.focus();
  },
);

watch(theme, async () => {
  await nextTick();
  if (term && host.value) term.options.theme = tokenTheme(host.value);
});

// ⌘F with focus in the find bar itself selects the query again rather than the window's.
function onFrameKeydown(e: KeyboardEvent): void {
  if (!isFindKey(e) || !findOpen.value) return;
  e.preventDefault();
  e.stopPropagation();
  void openFind();
}

onBeforeUnmount(() => {
  observer?.disconnect();
  store.detach(props.terminalId);
  term?.dispose();
});
</script>

<template>
  <!-- The padding lives on the frame: FitAddon measures the host's box as the grid area. -->
  <div ref="frame" class="k-term-view" @keydown="onFrameKeydown">
    <KFindBar
      v-if="findOpen"
      v-model:query="findQuery"
      v-model:match-case="findCase"
      v-model:whole-word="findWord"
      class="k-term-view__find"
      :placeholder="t('kit.terminal.findPlaceholder')"
      :count="findCount"
      :has-hits="results.count > 0"
      @step="findStep"
      @close="closeFind"
    />
    <div ref="host" class="k-term-view__host"></div>
    <KSkeleton v-if="phase === 'skeleton'" class="k-term-view__skeleton" variant="lines" :rows="4" />
  </div>
</template>

<style scoped lang="scss">
.k-term-view {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 6px 0 0 var(--k-sp-3);
  box-sizing: border-box;
  background: var(--k-bg);
  overflow: hidden;
}
// The bar takes its row off the grid; the ResizeObserver refits the shell to what is left.
.k-term-view__find {
  margin: -6px 0 6px calc(-1 * var(--k-sp-3));
}
.k-term-view__host {
  flex: 1;
  width: 100%;
  min-height: 0;
}
.k-term-view__skeleton {
  position: absolute;
  inset: 6px var(--k-sp-3) auto var(--k-sp-3);
}
</style>
