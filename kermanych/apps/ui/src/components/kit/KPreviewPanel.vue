<template>
  <section ref="rootEl" class="k-preview-logs" :style="{ height: size + 'px' }" :aria-label="envOpen ? t('agents.preview.envAria') : t('agents.preview.logsAria')">
    <div
      class="k-preview-logs__seam"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('agents.preview.logsResize')"
      :aria-valuenow="Math.round(size)"
      :aria-valuemin="MIN_HEIGHT"
      tabindex="0"
      @pointerdown="startResize"
      @keydown="onKeydown"
    ></div>
    <div class="k-preview-logs__head">
      <div v-if="envOpen" class="k-preview-logs__tabs">
        <span class="k-preview-logs__tab k-preview-logs__tab--on mono">.env</span>
      </div>
      <div v-else class="k-preview-logs__tabs" role="tablist">
        <button
          v-for="s in tabs"
          :key="s"
          type="button"
          role="tab"
          class="k-preview-logs__tab mono"
          :class="{ 'k-preview-logs__tab--on': s === step }"
          :aria-selected="s === step"
          @click="pickStep(s)"
        >{{ s }}</button>
      </div>
      <KIconButton :title="envOpen ? t('agents.preview.envClose') : t('agents.preview.logsClose')" @click="closePanel">✕</KIconButton>
    </div>
    <div v-if="envOpen" class="k-preview-logs__body">
      <KSessionEnv :session="session" :preview="preview" />
    </div>
    <div v-else ref="bodyEl" class="k-preview-logs__body" @scroll="onScroll">
      <p v-if="error && !buffer" class="k-preview-logs__note k-preview-logs__note--error" role="alert">
        {{ t('agents.preview.logsFailed', { error }) }}
      </p>
      <KSkeleton v-else-if="phase === 'skeleton'" variant="lines" :rows="4" />
      <template v-else-if="phase === 'ready'">
        <pre v-if="buffer?.lines.length" class="k-preview-logs__text mono">{{ text }}</pre>
        <p v-else class="k-preview-logs__note">{{ t('agents.preview.logsEmpty') }}</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
// The bottom panel of the live preview, «Логи» or «Змінні» (docs/specs/2026-11-03-session-browser-
// preview.md, decisions 6–7; docs/specs/2026-11-04-session-env-and-tester-preview-gate.md,
// decision 2): INSIDE the pane, never an overlay — the native page view sits above the whole DOM
// — so the page box above shrinks behind the seam and the pane re-reports its bounds (its
// ResizeObserver); while the seam is dragged the pane parks the page (`resizing`), or the pointer
// would vanish into it. «Логи»: one tab per step of the current run (`setup`, then each service),
// polled every second with the step's cursor while shown; a new run starts every step's buffer
// over. «Змінні»: the session's `.env` (KSessionEnv).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { PREVIEW_SETUP_STEP, type Session } from '@kermanych/core';
import KIconButton from './KIconButton.vue';
import KSessionEnv from './KSessionEnv.vue';
import KSkeleton from './KSkeleton.vue';
import { useOrchestrator } from 'stores/orchestrator';
import { errorText } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useResizablePanel } from '../../composables/useResizablePanel';
import { mergePreviewLogs, type PreviewLogBuffer } from '../../lib/preview-view';
import type { SessionPreview } from '../../composables/useSessionPreview';

const POLL_MS = 1_000;
const MIN_HEIGHT = 96;
// What the page keeps above the panel at the least.
const MIN_PAGE = 120;

const props = defineProps<{ session: Session; preview: SessionPreview }>();
const emit = defineEmits<{ resizing: [on: boolean] }>();

const { t } = useI18n();
const store = useOrchestrator();
const { state, logsOpen, envOpen, logsStep, closePanel } = props.preview;

const rootEl = ref<HTMLElement | null>(null);
const { size, resizing, startResize, onKeydown, refresh } = useResizablePanel({
  storageKey: 'kermanych.agents.preview-logs-height',
  defaultSize: 220,
  min: MIN_HEIGHT,
  edge: 'top',
  max: () => {
    const host = rootEl.value?.parentElement?.clientHeight;
    return host ? host - MIN_PAGE : Number.POSITIVE_INFINITY;
  },
});
watch(resizing, (on) => emit('resizing', on));

// The steps of the current run that have a log (from the last answer), and each step's lines.
const steps = ref<string[]>([]);
const run = ref<number | undefined>(undefined);
const buffers = ref<Record<string, PreviewLogBuffer>>({});
const error = ref<string | null>(null);

// No step picked yet: the one starting or the one that broke, else the newest of the run.
const step = computed(() => {
  if (logsStep.value) return logsStep.value;
  const s = state.value;
  if (s && (s.phase === 'starting' || s.phase === 'crashed' || s.phase === 'failed')) return s.step;
  return steps.value[steps.value.length - 1] ?? PREVIEW_SETUP_STEP;
});
const tabs = computed(() => (steps.value.includes(step.value) ? steps.value : [...steps.value, step.value]));
const buffer = computed<PreviewLogBuffer | undefined>(() => buffers.value[step.value]);
const text = computed(() => buffer.value?.lines.map((l) => l.text).join('\n') ?? '');
const phase = useLoadPhase(() => !buffer.value && !error.value);

let inFlight = false;
async function poll(): Promise<void> {
  if (inFlight || !logsOpen.value) return;
  inFlight = true;
  const asked = step.value;
  try {
    const res = await store.previewLogs(props.session.id, asked, buffers.value[asked]?.next ?? 0);
    // A new run: what the panel holds belongs to a preview that no longer exists. The cursor is
    // global (`seq` only grows), so this answer already carries the new run's lines in full.
    if (run.value !== undefined && res.run !== run.value) buffers.value = {};
    run.value = res.run;
    steps.value = res.steps;
    const follow = pinned;
    buffers.value = { ...buffers.value, [asked]: mergePreviewLogs(buffers.value[asked], res) };
    error.value = null;
    if (follow) void nextTick(scrollToEnd);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    inFlight = false;
  }
}

// Follows the tail while the operator is at the bottom; scrolling up holds the view.
const bodyEl = ref<HTMLElement | null>(null);
let pinned = true;
function pickStep(s: string): void {
  logsStep.value = s;
}
function onScroll(): void {
  const el = bodyEl.value;
  if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
function scrollToEnd(): void {
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch([step, logsOpen], () => {
  pinned = true;
  void poll();
  void nextTick(scrollToEnd);
});

let timer: number | undefined;
onMounted(() => {
  refresh();
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<style scoped lang="scss">
.k-preview-logs {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--k-line);
  background: var(--k-surface);
}

// The seam straddles the panel's top border; a tall hit area, a thin line.
.k-preview-logs__seam {
  position: absolute;
  left: 0;
  right: 0;
  top: -4px;
  height: 7px;
  cursor: row-resize;
  z-index: 1;

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--k-accent) 40%, transparent);
    outline: none;
  }
}

.k-preview-logs__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-preview-logs__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 4px;
  overflow-x: auto;
}
.k-preview-logs__tab {
  flex: none;
  height: 24px;
  padding: 0 8px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--k-r-sm);
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}
.k-preview-logs__tab--on {
  color: var(--k-text);
  border-color: var(--k-line-strong);
  background: var(--k-surface2);
}

.k-preview-logs__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px;
}
.k-preview-logs__text {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.k-preview-logs__note {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-preview-logs__note--error {
  color: var(--k-danger);
}
</style>
