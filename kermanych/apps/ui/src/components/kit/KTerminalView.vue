<script setup lang="ts">
// One shell's screen: an xterm.js instance attached to a terminal the api runs
// (stores/terminal.ts). The view owns nothing but pixels — closing it detaches, the shell
// keeps running, and the next view to attach repaints from the api's replay.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from 'stores/terminal';
import { theme } from '../../lib/theme';

const props = defineProps<{ terminalId: string; active: boolean }>();

const store = useTerminal();
const host = ref<HTMLElement | null>(null);
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;

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
    scrollback: 5000,
    minimumContrastRatio: 4.5,
    theme: tokenTheme(el),
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  // Ctrl+` toggles the panel (MainLayout) — let it through to the window instead of
  // sending it to the shell.
  term.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.code === 'Backquote'));
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
    },
    data(chunk) {
      term?.write(chunk);
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

onBeforeUnmount(() => {
  observer?.disconnect();
  store.detach(props.terminalId);
  term?.dispose();
});
</script>

<template>
  <!-- The padding lives on the frame: FitAddon measures the host's box as the grid area. -->
  <div class="k-term-view">
    <div ref="host" class="k-term-view__host"></div>
  </div>
</template>

<style scoped lang="scss">
.k-term-view {
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 6px 0 0 var(--k-sp-3);
  box-sizing: border-box;
  background: var(--k-bg);
  overflow: hidden;
}
.k-term-view__host {
  width: 100%;
  height: 100%;
}
</style>
