<template>
  <!-- COMPACT: the status row of an agent's card in the «Агенти» list — the pipeline as dots and
       the current stage named. No actions: the card is itself a button. -->
  <div v-if="variant === 'compact'" v-tip.overflow="compactText" class="k-sl k-sl--compact">
    <span class="k-sl__dots" aria-hidden="true">
      <span v-for="s in pipeline.stages" :key="s.key" class="k-sl__dot" :class="`k-sl--${s.state}`" />
    </span>
    <span class="k-sl__compact-text mono" :class="`k-sl--${currentStage.state}`">{{ compactText }}</span>
  </div>

  <!-- FULL: under the session tab row, the width of the pane, on every tab. -->
  <div v-else class="k-sl k-sl--full" role="status" :aria-label="t('statusLine.label')">
    <ol class="k-sl__pipe">
      <li
        v-for="(s, i) in pipeline.stages"
        :key="s.key"
        class="k-sl__stage"
        :class="[`k-sl--${s.state}`, { 'k-sl__stage--key': s.key === pipeline.current || s.state === 'failed' }]"
      >
        <span v-if="i" class="k-sl__link" :class="{ 'k-sl__link--on': s.state !== 'todo' && s.state !== 'unknown' }" aria-hidden="true" />
        <button
          v-if="detailed(s.key)"
          :ref="(el) => setAnchor(s.key, el)"
          type="button"
          class="k-sl__body k-sl__body--btn"
          aria-haspopup="dialog"
          :aria-expanded="menu.open.value && openStage === s.key"
          :aria-label="t('statusLine.details', { stage: t(`statusLine.stage.${s.key}`) })"
          v-tip="tipOf(s)"
          @click="toggleStage(s.key)"
        >
          <span class="k-sl__node"><KSpinner v-if="s.state === 'running'" :size="11" /><template v-else>{{ NODE[s.state] }}</template></span>
          <span class="k-sl__name">{{ t(`statusLine.stage.${s.key}`) }}</span>
          <span v-if="s.note.length" class="k-sl__note mono">{{ render(s.note) }}</span>
        </button>
        <a
          v-else-if="s.key === 'pr' && prUrl && s.state === 'done'"
          class="k-sl__body k-sl__body--link"
          :href="prUrl"
          target="_blank"
          rel="noopener"
          v-tip="t('statusLine.openPr')"
        >
          <span class="k-sl__node">{{ NODE[s.state] }}</span>
          <span class="k-sl__name">{{ t(`statusLine.stage.${s.key}`) }}</span>
          <span v-if="s.note.length" class="k-sl__note mono">{{ render(s.note) }}</span>
        </a>
        <span v-else class="k-sl__body" v-tip="tipOf(s)">
          <span class="k-sl__node"><KSpinner v-if="s.state === 'running'" :size="11" /><template v-else>{{ NODE[s.state] }}</template></span>
          <span class="k-sl__name">{{ t(`statusLine.stage.${s.key}`) }}</span>
          <span v-if="s.note.length" class="k-sl__note mono">{{ render(s.note) }}</span>
        </span>
      </li>
    </ol>

    <span class="k-sl__actions">
      <KBtn v-if="session.status === 'queued' && session.slotWait" variant="secondary" :loading="busy.runNow" :disabled="blocked" @click="emit('runNow')">{{ t('statusLine.action.runNow') }}</KBtn>
      <KBtn v-if="stalled" variant="secondary" :loading="busy.restart" :disabled="blocked" @click="emit('restart')">{{ t('statusLine.action.restart') }}</KBtn>
      <KBtn v-if="session.status === 'waiting_input'" variant="secondary" @click="emit('answer')">{{ t('statusLine.action.answer') }}</KBtn>
      <template v-if="session.status === 'error'">
        <KBtn v-if="signIn" variant="secondary" @click="emit('signIn')">{{ t('statusLine.action.signIn') }}</KBtn>
        <KBtn v-else variant="secondary" :loading="busy.resume" :disabled="blocked" @click="emit('resume')">{{ t('statusLine.action.resume') }}</KBtn>
      </template>
      <KBtn v-if="session.status === 'conflict'" variant="secondary" :loading="busy.resolve" :disabled="blocked" @click="emit('resolve')">{{ t('statusLine.action.resolve') }}</KBtn>
      <KBtn v-if="session.status === 'stopped' && !session.archived" variant="secondary" :loading="busy.resume" :disabled="blocked" @click="emit('resume')">{{ t('statusLine.action.continue') }}</KBtn>
      <template v-if="watching">
        <KBtn v-if="loop!.loop.phase === 'paused'" variant="secondary" :loading="busy.loopResume" @click="emit('loopResume')">{{ t('prLoop.action.resume') }}</KBtn>
        <KBtn
          v-if="canSend"
          variant="secondary"
          :loading="busy.loopSend"
          :disabled="busySession"
          v-tip="busySession ? t('prLoop.busy') : ''"
          @click="emit('loopSend')"
        >{{ t('prLoop.action.send') }}</KBtn>
      </template>
    </span>

    <!-- The details of CI and Ревʼю (decision 4): what the merge-box rows used to say, with the
         per-comment «Передати». Under <body>, placed by useAnchoredMenu. -->
    <Teleport to="body">
      <div
        v-if="menu.open.value && openStage && loop"
        ref="menuEl"
        class="k-sl__pop"
        role="dialog"
        :aria-label="t('statusLine.details', { stage: t(`statusLine.stage.${openStage}`) })"
      >
        <p class="k-sl__pop-title mono">{{ t(`statusLine.stage.${openStage}`) }}</p>

        <template v-if="openStage === 'ci'">
          <p class="k-sl__pop-row" :class="`k-sl__ci--${loop.ci.state}`">{{ ciText }}</p>
          <ul v-if="loop.ci.failed.length" class="k-sl__pop-list">
            <li v-for="f in loop.ci.failed" :key="f.name">
              <a v-if="f.url" class="k-sl__pop-link" :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a>
              <span v-else>{{ f.name }}</span>
            </li>
          </ul>
          <p v-if="loop.ci.stuckMin !== undefined" class="k-sl__pop-row k-sl__warn">{{ t('prLoop.ci.stuck', { min: loop.ci.stuckMin }) }}</p>
        </template>

        <template v-else>
          <p class="k-sl__pop-row">
            {{ t(`prLoop.review.${loop.review.decision}`) }}<template v-if="loop.review.pending"> · {{ t('prLoop.review.pending', { n: loop.review.pending }, loop.review.pending) }}</template>
          </p>
          <ul v-if="loop.review.untrusted.length" class="k-sl__pop-list">
            <li v-for="c in loop.review.untrusted" :key="c.key" class="k-sl__pop-item">
              <a class="k-sl__pop-link" :href="c.url" target="_blank" rel="noopener">@{{ c.author }}</a>
              <span class="k-sl__muted">{{ t('prLoop.review.untrusted') }}</span>
              <KBtn
                variant="ghost"
                :loading="busy.pass?.includes(c.key)"
                :disabled="busySession"
                v-tip="busySession ? t('prLoop.busy') : ''"
                @click="emit('pass', c.key)"
              >{{ t('prLoop.review.pass') }}</KBtn>
            </li>
          </ul>
          <p class="k-sl__pop-label mono">{{ t('prLoop.row.loop') }}</p>
          <p class="k-sl__pop-row">{{ loopText }}</p>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PrLoopState, Session } from '@kermanych/core';
// Directly from core's status module, like lib/attention.ts (see the note there).
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import KBtn from './KBtn.vue';
import KSpinner from './KSpinner.vue';
import { useNow } from '../../composables/useNow';
import { useAnchoredMenu } from '../../composables/useAnchoredMenu';
import { relativeTime, renderTime, type TimeLabel } from '../../lib/time';
import { needsSignIn } from '../../lib/session-auth';
import {
  pipelineOf,
  silentMs,
  STALL_MS,
  type NotePart,
  type Stage,
  type StageKey,
  type StageState,
  type StatusLineLoading,
} from '../../lib/status-line';

// The session status line as a stage pipeline, «like GitLab»
// (docs/specs/2026-11-25-status-line-pipeline.md): `Задача → Агент → ПР → CI → Ревʼю → Злиття`,
// each stage ✓ / spinner / ● / ✗ / ○ with a short note; which stage and what state is
// lib/status-line.ts `pipelineOf`. Two variants: `full` sits under the session tab row with the
// action the status asks for; `compact` is the status row of an agent's card. A narrow pane
// keeps the current and failed stages spelled out and shrinks the rest to their node (a
// container query, no measuring). CI and Ревʼю open a popover with the «Петля після ПР» details.
//
// Presentational like the rest of the kit: every button emits, and the page wires it to the
// action the rest of the page runs (AgentsPage). `loading` drives each button's spinner;
// `blocked` — another action on this session is still settling (stores/pending).
const props = withDefaults(
  defineProps<{
    session: Session;
    loop?: PrLoopState | null | undefined;
    variant?: 'full' | 'compact';
    loading?: StatusLineLoading | undefined;
    blocked?: boolean;
  }>(),
  { loop: null, variant: 'full', loading: undefined, blocked: false },
);

const emit = defineEmits<{
  /** `queued` behind the slot limit: «Запустити зараз». */
  runNow: [];
  /** A stalled turn: «Перезапустити». */
  restart: [];
  /** `waiting_input`: «Відповісти» — the page focuses where the answer goes. */
  answer: [];
  /** `error` «Відновити», `stopped` «Продовжити»: wake the session. */
  resume: [];
  /** A provider sign-in error: «Увійти» — the page re-checks the sign-in. */
  signIn: [];
  /** `conflict`: «Розвʼязати». */
  resolve: [];
  /** The loop paused on its round limit: «Продовжити петлю». */
  loopResume: [];
  /** «Передати агенту»: hand the PR's feedback over now. */
  loopSend: [];
  /** «Передати» on one comment from an author without access: its key. */
  pass: [key: string];
}>();

const { t } = useI18n();
// The full line shows a silence in seconds; a list card only minutes.
const now = useNow(props.variant === 'full' ? 1000 : 15_000);

// `todo` is the empty ring itself; a glyph inside it would read as ◎.
const NODE: Record<StageState, string> = { done: '✓', running: '', waiting: '●', failed: '✗', todo: '', unknown: '–' };

const pipeline = computed(() => pipelineOf(props.session, props.loop, now.value));
const currentStage = computed(() => pipeline.value.stages.find((s) => s.key === pipeline.value.current) ?? pipeline.value.stages[0]!);

const signIn = computed(() => props.session.status === 'error' && needsSignIn(props.session.errorCode));
const stalled = computed(() => silentMs(props.session, now.value) >= STALL_MS);
const busySession = computed(() => ACTIVE_STATUSES.includes(props.session.status));
const busy = computed<StatusLineLoading>(() => props.loading ?? {});

// The loop state worth acting on: an open PR the loop can read.
const loop = computed(() => (props.session.prOpened || props.session.status === 'in_review' ? props.loop ?? null : null));
const watching = computed(() => !!loop.value && !loop.value.unavailable && loop.value.loop.phase !== 'ended');
const prUrl = computed(() => loop.value?.pr?.url ?? props.session.prUrl);

// «Передати агенту»: manual mode with something to pass, or a loop paused on its limit (the
// manual pass works past it). The api refuses a pass with nothing in it and says so.
const canSend = computed(() => {
  const l = loop.value!.loop;
  return l.mode === 'manual' || l.phase === 'paused' || l.phase === 'manual_ready';
});

/** A note's parts, `·`-joined. A param that is itself a time label is rendered first. */
function render(parts: readonly NotePart[]): string {
  return parts
    .map((p) => {
      if ('text' in p) return p.text;
      const params = Object.fromEntries(
        Object.entries(p.params ?? {}).map(([name, v]) => [name, v && typeof v === 'object' && 'key' in v ? renderTime(t, v as TimeLabel) : v]),
      );
      const n = p.n ?? (typeof params.n === 'number' ? params.n : undefined);
      return n === undefined ? t(p.key, params) : t(p.key, params, n);
    })
    .join(' · ');
}

/** The stage's tooltip: its name, its note in full (a narrow pane hides it) and the reason. */
function tipOf(s: Stage): string {
  return [t(`statusLine.stage.${s.key}`), render(s.note), s.tip ? render(s.tip) : ''].filter(Boolean).join(' · ');
}

const compactText = computed(() => {
  const s = currentStage.value;
  const name = t(`statusLine.stage.${s.key}`);
  return s.note.length ? `${name} · ${render(s.note)}` : name;
});

// ── CI / Ревʼю details ──────────────────────────────────────────────────────
const detailed = (key: StageKey): boolean => watching.value && (key === 'ci' || key === 'review');
const anchors = new Map<StageKey, HTMLElement>();
function setAnchor(key: StageKey, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) anchors.set(key, el);
  else anchors.delete(key);
}
const anchorEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menu = useAnchoredMenu(anchorEl, menuEl);
const openStage = ref<StageKey | null>(null);
function toggleStage(key: StageKey): void {
  if (menu.open.value && openStage.value === key) {
    menu.close();
    return;
  }
  menu.close();
  openStage.value = key;
  anchorEl.value = anchors.get(key) ?? null;
  void menu.show();
}
// The loop went away (PR merged, session left review): nothing left to show.
watch(watching, (w) => {
  if (!w) menu.close();
});

const ciText = computed(() => {
  const ci = loop.value!.ci;
  switch (ci.state) {
    case 'pending':
      return t('prLoop.ci.pending', { done: ci.done, total: ci.total });
    case 'success':
      return t('prLoop.ci.success', { total: ci.total });
    case 'failure':
      return t('prLoop.ci.failure', { n: ci.failed.length, total: ci.total }, ci.failed.length);
    default:
      return t('prLoop.ci.none');
  }
});

const loopText = computed(() => {
  const l = loop.value!.loop;
  const parts = [t(`prLoop.mode.${l.mode}`)];
  if (l.mode === 'auto') parts.push(t('prLoop.round', { round: l.round, max: l.maxRounds }));
  if (l.lastSentAt) parts.push(t('prLoop.lastSent', { time: renderTime(t, relativeTime(l.lastSentAt, now.value)) }));
  parts.push(l.phase === 'paused' ? t('prLoop.phase.paused', { n: l.maxRounds }, l.maxRounds) : t(`prLoop.phase.${l.phase}`));
  return parts.join(' · ');
});
</script>

<style scoped lang="scss">
.k-sl {
  --k-sl-tone: var(--k-faint);
  min-width: 0;
  color: var(--k-muted);
}

.k-sl--done { --k-sl-tone: var(--k-success); }
.k-sl--running { --k-sl-tone: var(--k-accent); }
.k-sl--waiting { --k-sl-tone: var(--k-warning); }
.k-sl--failed { --k-sl-tone: var(--k-danger); }
.k-sl--todo,
.k-sl--unknown { --k-sl-tone: var(--k-faint); }

// ── Compact ──────────────────────────────────────────────────────────────────
// One line that never wraps: the card keeps its height; the whole line is the tooltip.
.k-sl--compact {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}

.k-sl__dots {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.k-sl__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--k-sl-tone);

  &.k-sl--todo,
  &.k-sl--unknown {
    background: transparent;
    border: 1px solid var(--k-line-strong);
  }

  // The stage that runs pulses, as KStatusDot does.
  &.k-sl--running { animation: k-sl-pulse 1.1s ease-in-out infinite; }
}

.k-sl__compact-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--k-fs-xs);
  color: var(--k-sl-tone);

  &.k-sl--done,
  &.k-sl--todo,
  &.k-sl--unknown { color: var(--k-muted); }
}

// ── Full ─────────────────────────────────────────────────────────────────────
.k-sl--full {
  flex: none;
  display: flex;
  // The buttons drop under the pipeline when both cannot share the row (a narrow pane with
  // two loop actions): the pipeline never runs under them.
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-2) var(--k-sp-3);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  font-size: var(--k-fs-sm);
  container-type: inline-size;
}

.k-sl__pipe {
  flex: 1 1 auto;
  // Every node, two links and a few words of the current stage.
  min-width: min(100%, 280px);
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  margin: 0;
  padding: 0;
  list-style: none;
}

.k-sl__stage {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: flex-start;
}

.k-sl__link {
  // A `width`, not a flex-basis: an empty span's max-content is 0, so a basis would be left out
  // of the stage's intrinsic width and then taken from the words.
  flex: 0 1 auto;
  width: 32px;
  min-width: 8px;
  height: 1.5px;
  margin: 10px 6px 0;
  background: var(--k-line-strong);

  &--on { background: var(--k-success); }
}

.k-sl__body {
  min-width: 0;
  display: grid;
  // `auto`, not minmax(0, …): the stage keeps its natural width while there is room, and the
  // words (overflow hidden, so their automatic minimum is 0) ellipsize when there is not.
  grid-template-columns: 20px auto;
  grid-template-rows: 20px auto;
  column-gap: 6px;
  align-items: center;
  padding: 1px 4px 1px 1px;
  border: 0;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
}

.k-sl__body--btn,
.k-sl__body--link {
  cursor: pointer;

  &:hover { background: var(--k-surface2); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 1px; }
}

.k-sl__node {
  grid-row: 1;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  box-sizing: border-box;
  border: 1.5px solid var(--k-sl-tone);
  border-radius: 50%;
  color: var(--k-sl-tone);
  font-size: 10px;
  line-height: 1;
}

.k-sl--done .k-sl__node,
.k-sl--failed .k-sl__node {
  background: var(--k-sl-tone);
  color: var(--k-on-accent);
}

.k-sl__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--k-text);
  font-weight: var(--k-fw-medium);
}

.k-sl--todo .k-sl__name,
.k-sl--unknown .k-sl__name { color: var(--k-faint); font-weight: var(--k-fw-regular); }

.k-sl__note {
  grid-column: 2;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-sl-tone);
}

.k-sl--done .k-sl__note { color: var(--k-muted); }

// Narrow pane (decision 5): only the current and failed stages keep their words.
@container (max-width: 760px) {
  // The shrunk stages keep their node whole; the words of the key ones take what is left.
  .k-sl__stage:not(.k-sl__stage--key) {
    flex: none;

    .k-sl__name,
    .k-sl__note { display: none; }
    .k-sl__body { column-gap: 0; padding-right: 1px; }
  }

  .k-sl__link { width: 16px; min-width: 6px; margin-inline: 3px; }
}

// Very narrow (a button beside the pipeline in a ~400px pane): the links go hairline-short so
// the current stage keeps a readable name.
@container (max-width: 480px) {
  .k-sl__link { width: 4px; min-width: 4px; margin-inline: 1px; }
}

.k-sl__actions {
  flex: none;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);

  &:empty { display: none; }
}

// ── The CI / Ревʼю popover ───────────────────────────────────────────────────
.k-sl__pop {
  position: fixed;
  z-index: 6500;
  width: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.k-sl__pop-title,
.k-sl__pop-label {
  margin: 0;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.k-sl__pop-label { color: var(--k-faint); }
.k-sl__pop-row { margin: 0; }

.k-sl__pop-list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.k-sl__pop-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 var(--k-sp-2);
}

.k-sl__pop-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--k-line-strong);
  text-underline-offset: 2px;

  &:hover { text-decoration-color: currentColor; }
}

.k-sl__muted { color: var(--k-faint); }
.k-sl__warn { color: var(--k-warning); }
.k-sl__ci--failure { color: var(--k-danger); }
.k-sl__ci--success { color: var(--k-success); }
.k-sl__ci--pending { color: var(--k-accent); }

@keyframes k-sl-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .k-sl__dot.k-sl--running { animation: none; }
}
</style>
