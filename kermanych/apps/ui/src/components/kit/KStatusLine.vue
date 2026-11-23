<template>
  <!-- COMPACT: one quiet line in the «Агенти» list card, under the «● status» row. No actions:
       the card is itself a button, and the full line is one click away. -->
  <div
    v-if="variant === 'compact'"
    v-tip.overflow="compactText"
    class="k-sl k-sl--compact mono"
    :class="`k-sl--${tone}`"
  >
    <span class="k-sl__glyph" aria-hidden="true">{{ glyph }}</span>
    <span class="k-sl__text">{{ compactText }}</span>
  </div>

  <!-- FULL: under the session tab row, the width of the pane, on every tab. -->
  <div v-else class="k-sl k-sl--full" :class="`k-sl--${tone}`" role="status">
    <div class="k-sl__head">
      <span class="k-sl__glyph" aria-hidden="true">{{ glyph }}</span>
      <span class="k-sl__text">
        <span class="k-sl__title">{{ title }}</span>
        <template v-if="prNumber !== undefined">
          · <a v-if="prUrl" class="k-sl__link" :href="prUrl" target="_blank" rel="noopener" v-tip="t('statusLine.openPr')">#{{ prNumber }}</a>
          <span v-else>#{{ prNumber }}</span>
        </template>
        <span v-for="(d, i) in details" :key="i" class="k-sl__detail"> · {{ d }}</span>
        <span v-if="mergeBox && collapsed && loopSummary" class="k-sl__detail"> · {{ loopSummary }}</span>
        <span v-if="ready" class="k-sl__ready"> · {{ t('prLoop.ready') }}</span>
      </span>

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
        <button
          v-if="mergeBox"
          type="button"
          class="k-sl__toggle"
          :aria-expanded="!collapsed"
          v-tip="collapsed ? t('statusLine.expand') : t('statusLine.collapse')"
          :aria-label="collapsed ? t('statusLine.expand') : t('statusLine.collapse')"
          @click="collapsed = !collapsed"
        >{{ collapsed ? '▸' : '▾' }}</button>
      </span>
    </div>

    <!-- The merge-box (decision 15): CI, review, conflicts and the loop itself, one row each. -->
    <dl v-if="mergeBox && !collapsed && loop" class="k-sl__box">
      <dt class="k-sl__label mono">{{ t('prLoop.row.ci') }}</dt>
      <dd class="k-sl__row">
        <span :class="`k-sl__ci--${loop.ci.state}`">{{ ciText }}</span>
        <template v-if="loop.ci.failed.length">
          (<template v-for="(f, i) in loop.ci.failed" :key="f.name"><template v-if="i">, </template><a v-if="f.url" class="k-sl__link" :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a><span v-else>{{ f.name }}</span></template>)
        </template>
        <span v-if="loop.ci.stuckMin !== undefined" class="k-sl__warn"> · {{ t('prLoop.ci.stuck', { min: loop.ci.stuckMin }) }}</span>
      </dd>

      <dt class="k-sl__label mono">{{ t('prLoop.row.review') }}</dt>
      <dd class="k-sl__row">
        <span>{{ t(`prLoop.review.${loop.review.decision}`) }}</span>
        <span v-if="loop.review.pending"> · {{ t('prLoop.review.pending', { n: loop.review.pending }, loop.review.pending) }}</span>
        <ul v-if="loop.review.untrusted.length" class="k-sl__untrusted">
          <li v-for="c in loop.review.untrusted" :key="c.key" class="k-sl__untrusted-item">
            <a class="k-sl__link" :href="c.url" target="_blank" rel="noopener">@{{ c.author }}</a>
            <span class="k-sl__muted"> · {{ t('prLoop.review.untrusted') }}</span>
            <KBtn
              variant="ghost"
              :loading="busy.pass?.includes(c.key)"
              :disabled="busySession"
              v-tip="busySession ? t('prLoop.busy') : ''"
              @click="emit('pass', c.key)"
            >{{ t('prLoop.review.pass') }}</KBtn>
          </li>
        </ul>
      </dd>

      <dt class="k-sl__label mono">{{ t('prLoop.row.conflicts') }}</dt>
      <dd class="k-sl__row" :class="{ 'k-sl__warn': loop.mergeable === 'conflict' }">{{ mergeableText }}</dd>

      <dt class="k-sl__label mono">{{ t('prLoop.row.loop') }}</dt>
      <dd class="k-sl__row">
        <span>{{ loopText }}</span>
        <span class="k-sl__row-actions">
          <KBtn v-if="loop.loop.phase === 'paused'" variant="secondary" :loading="busy.loopResume" @click="emit('loopResume')">{{ t('prLoop.action.resume') }}</KBtn>
          <KBtn
            v-if="canSend"
            variant="secondary"
            :loading="busy.loopSend"
            :disabled="busySession"
            v-tip="busySession ? t('prLoop.busy') : ''"
            @click="emit('loopSend')"
          >{{ t('prLoop.action.send') }}</KBtn>
        </span>
      </dd>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { isReadyToMerge, type PrLoopState, type Session } from '@kermanych/core';
// Directly from core's status module, like lib/attention.ts (see the note there).
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import KBtn from './KBtn.vue';
import { useNow } from '../../composables/useNow';
import { dur, relativeTime, renderTime } from '../../lib/time';
import { needsSignIn } from '../../lib/session-auth';
import { prNumberFromUrl, silentMs, STALL_MS, statusLineCollapsed, type StatusLineLoading } from '../../lib/status-line';

// The session status line (docs/specs/2026-11-23-pr-feedback-loop.md, decisions 12–15): one
// sentence per status, «like GitHub / GitLab», with the action the status asks for. Two variants:
// `full` sits under the session tab row and carries the actions; `compact` is a row of the
// «Агенти» list card. For a session on review whose PR «Петля після ПР» watches (`loop`), the
// full line expands into a merge-box — CI, review, conflicts, the loop — that folds to its
// summary; the fold is remembered on this device (lib/status-line.ts).
//
// Presentational like the rest of the kit: every button emits, and the page wires it to the SAME
// action today's buttons and banners run (AgentsPage). The page passes what is in flight through
// `loading` (each button's spinner) and `blocked` (another action on this session is still
// settling — stores/pending). Existing status displays (KStatusDot, the header's «harness ·
// status», KStatusRow, KPanel's banners) are untouched (decision 12).
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
  /** A provider sign-in error: «Увійти» — the page re-checks the sign-in, as the top bar's
   *  «Потрібен вхід» pill does; the title names the command that signs in. */
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
const collapsed = statusLineCollapsed;

const status = computed(() => props.session.status);
const signIn = computed(() => status.value === 'error' && needsSignIn(props.session.errorCode));
const silence = computed(() => silentMs(props.session, now.value));
const stalled = computed(() => silence.value >= STALL_MS);
const busySession = computed(() => ACTIVE_STATUSES.includes(status.value));
const busy = computed<StatusLineLoading>(() => props.loading ?? {});

// The loop state worth showing: one for an open PR the loop can read. An unavailable state only
// names why; an ended one only says so.
const loop = computed(() => (status.value === 'in_review' ? props.loop ?? null : null));
const watching = computed(() => !!loop.value && !loop.value.unavailable);
const mergeBox = computed(() => watching.value && loop.value!.loop.phase !== 'ended');
const ready = computed(() => watching.value && isReadyToMerge(loop.value!));

const prUrl = computed(() => loop.value?.pr?.url ?? props.session.prUrl);
const prNumber = computed(() =>
  status.value === 'in_review' ? (loop.value?.pr?.number ?? prNumberFromUrl(props.session.prUrl)) : undefined,
);

// Durations: the Session carries no «since» per status, so `lastActivityAt` — the last time the
// session moved (its status included) — stands in for when it entered `queued` / `waiting_input`
// and for when it stopped or finished.
const sinceActivity = computed(() => renderTime(t, dur(Math.max(0, now.value - Date.parse(props.session.lastActivityAt)))));
const agoActivity = computed(() => renderTime(t, relativeTime(props.session.lastActivityAt, now.value)));
const silenceText = computed(() => t('statusLine.silence', { value: renderTime(t, dur(silence.value)) }));

type Tone = 'running' | 'waiting' | 'error' | 'done' | 'cold';
const tone = computed<Tone>(() => {
  switch (status.value) {
    case 'queued':
    case 'thinking':
    case 'tool':
      return 'running';
    case 'waiting_input':
    case 'conflict':
      return 'waiting';
    case 'error':
      return 'error';
    case 'done':
    case 'merged':
      return 'done';
    case 'in_review':
      return loop.value?.ci.state === 'failure' || loop.value?.loop.phase === 'paused' ? 'error' : ready.value ? 'done' : 'cold';
    default:
      return 'cold';
  }
});

const GLYPH: Record<Session['status'], string> = {
  backlog: '○',
  // Not ⏳: a colour emoji breaks the line's monochrome glyph set and does not render everywhere.
  queued: '◌',
  thinking: '◆',
  tool: '◆',
  waiting_input: '●',
  error: '✗',
  conflict: '⚠',
  stopped: '○',
  done: '✓',
  in_review: '◇',
  merged: '✓',
};
const glyph = computed(() => GLYPH[status.value]);

// ── Full ───────────────────────────────────────────────────────────────────
const title = computed(() => {
  const s = props.session;
  switch (s.status) {
    case 'queued':
      return s.slotWait ? t('statusLine.queued') : t('statusLine.starting');
    case 'thinking':
      return t('statusLine.thinking');
    case 'tool':
      return s.currentTool ?? t('statusLine.tool');
    case 'waiting_input':
      return t('statusLine.waiting');
    case 'error':
      return signIn.value
        ? t('statusLine.signIn', { reason: t(`notices.${s.errorCode}`) })
        : s.error ? t('statusLine.error', { reason: s.error }) : t('statusLine.errorPlain');
    case 'conflict':
      return s.baseBranch ? t('statusLine.conflict', { base: s.baseBranch }) : t('statusLine.conflictPlain');
    case 'stopped':
      return t('statusLine.stopped');
    case 'done':
      return t('statusLine.done');
    case 'in_review':
      return t('statusLine.review');
    case 'merged':
      return s.branch ? t('statusLine.merged', { branch: s.branch }) : t('statusLine.mergedPlain');
    case 'backlog':
      return t('statusLine.backlog');
    default:
      return s.status;
  }
});

// What follows the title, `·`-joined.
const details = computed<string[]>(() => {
  const s = props.session;
  switch (s.status) {
    case 'queued': {
      const w = s.slotWait;
      const out = w ? [t('statusLine.slots', { running: w.running, limit: w.limit })] : [];
      if (w && w.position > 1) out.push(t('statusLine.position', { position: w.position }));
      out.push(sinceActivity.value);
      return out;
    }
    case 'thinking':
    case 'tool':
      return s.lastEventAt ? [silenceText.value] : [];
    case 'waiting_input':
      return [sinceActivity.value];
    case 'stopped':
    case 'done':
      return [agoActivity.value];
    case 'in_review': {
      const l = loop.value;
      if (l?.unavailable) return [t(`prLoop.unavailable.${l.unavailable}`)];
      if (l?.loop.phase === 'ended') return [t(`prLoop.ended.${l.pr?.state === 'merged' ? 'merged' : 'closed'}`)];
      return [];
    }
    default:
      return [];
  }
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

const mergeableText = computed(() => {
  const m = loop.value!.mergeable;
  if (m !== 'conflict') return t(`prLoop.mergeable.${m}`);
  const base = props.session.baseBranch;
  return base ? t('prLoop.mergeable.conflict', { base }) : t('prLoop.mergeable.conflictPlain');
});

const loopText = computed(() => {
  const l = loop.value!.loop;
  const parts = [t(`prLoop.mode.${l.mode}`)];
  if (l.mode === 'auto') parts.push(t('prLoop.round', { round: l.round, max: l.maxRounds }));
  if (l.lastSentAt) parts.push(t('prLoop.lastSent', { time: renderTime(t, relativeTime(l.lastSentAt, now.value)) }));
  parts.push(l.phase === 'paused' ? t('prLoop.phase.paused', { n: l.maxRounds }, l.maxRounds) : t(`prLoop.phase.${l.phase}`));
  return parts.join(' · ');
});

// «Передати агенту»: manual mode with something to pass, or a loop paused on its limit (the
// manual pass works past it). The api refuses a pass with nothing in it and says so.
const canSend = computed(() => {
  const l = loop.value!;
  return l.loop.mode === 'manual' || l.loop.phase === 'paused' || l.loop.phase === 'manual_ready';
});

// ── Compact (and the folded merge-box's summary) ────────────────────────────
const loopSummary = computed(() => {
  const l = loop.value;
  if (!l || l.unavailable) return '';
  const parts: string[] = [];
  const ci = l.ci;
  // A failure is the actionable fact; a hung check only when nothing failed.
  if (ci.state === 'failure') parts.push(`CI ✗ ${ci.failed.length}/${ci.total}`);
  else if (ci.stuckMin !== undefined) parts.push(t('prLoop.compact.stuck'));
  else if (ci.state === 'pending') parts.push(`CI ● ${ci.done}/${ci.total}`);
  else if (ci.state === 'success') parts.push(`CI ✓ ${ci.total}/${ci.total}`);
  const comments = l.review.pending + l.review.untrusted.length;
  if (comments) parts.push(t('prLoop.compact.comments', { n: comments }, comments));
  if (l.loop.phase === 'paused') parts.push(t('prLoop.compact.paused'));
  else if (l.loop.mode === 'manual') parts.push(t('prLoop.compact.manual'));
  else if (l.loop.round > 0) parts.push(t('prLoop.compact.round', { round: l.loop.round, max: l.loop.maxRounds }));
  if (isReadyToMerge(l)) parts.push(t('prLoop.compact.ready'));
  return parts.join(' · ');
});

const compactText = computed(() => {
  const s = props.session;
  switch (s.status) {
    case 'queued':
      return `${t('statusLine.compact.queued')} · ${sinceActivity.value}`;
    case 'tool':
      // `bash: pnpm test` reads `bash` in a card.
      return s.currentTool ? s.currentTool.split(/[:\s]/)[0]! : t('statusLine.compact.tool');
    case 'waiting_input':
      return `${t('statusLine.compact.waiting')} · ${sinceActivity.value}`;
    case 'error':
      return signIn.value ? t('statusLine.compact.signIn') : t('statusLine.compact.error');
    case 'in_review':
      return mergeBox.value && loopSummary.value ? loopSummary.value : t('statusLine.compact.review');
    case 'thinking':
      return t('statusLine.compact.thinking');
    case 'conflict':
      return t('statusLine.compact.conflict');
    case 'stopped':
      return t('statusLine.compact.stopped');
    case 'done':
      return t('statusLine.compact.done');
    case 'merged':
      return t('statusLine.compact.merged');
    default:
      return t('statusLine.compact.backlog');
  }
});
</script>

<style scoped lang="scss">
.k-sl {
  --k-sl-tone: var(--k-muted);
  min-width: 0;
  color: var(--k-muted);
}

.k-sl--running { --k-sl-tone: var(--k-accent); }
.k-sl--waiting { --k-sl-tone: var(--k-warning); }
.k-sl--error { --k-sl-tone: var(--k-danger); }
.k-sl--done { --k-sl-tone: var(--k-success); }
.k-sl--cold { --k-sl-tone: var(--k-faint); }

.k-sl__glyph {
  flex: none;
  color: var(--k-sl-tone);
}

// ── Compact ──────────────────────────────────────────────────────────────────
// One line that never wraps: the card keeps its height; the whole line is the tooltip.
.k-sl--compact {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  white-space: nowrap;
  overflow: hidden;

  .k-sl__glyph { width: 7px; text-align: center; }
  .k-sl__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
}

// ── Full ─────────────────────────────────────────────────────────────────────
.k-sl--full {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  font-size: var(--k-fs-sm);
}

.k-sl__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  min-height: 28px;
}

.k-sl__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.k-sl__title { color: var(--k-text); }
.k-sl__ready { color: var(--k-success); }
.k-sl__warn { color: var(--k-warning); }
.k-sl__muted { color: var(--k-faint); }

.k-sl__link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--k-line-strong);
  text-underline-offset: 2px;

  &:hover { color: var(--k-text); text-decoration-color: currentColor; }
}

.k-sl__actions,
.k-sl__row-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

// In the merge-box the value column is narrow on a narrow pane: the buttons wrap under the text
// rather than run out of the box.
.k-sl__row-actions {
  flex: 0 1 auto;
  flex-wrap: wrap;
  margin-left: auto;
}

.k-sl__toggle {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;

  &:hover { color: var(--k-text); background: var(--k-surface2); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 1px; }
}

.k-sl__box {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--k-sp-1) var(--k-sp-4);
  margin: 0;
  padding-left: calc(var(--k-sp-2) + 1ch);
}

.k-sl__label {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  line-height: 28px;
}

.k-sl__row {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.35em;
  min-height: 28px;
  margin: 0;
}

.k-sl__ci--failure { color: var(--k-danger); }
.k-sl__ci--success { color: var(--k-success); }
.k-sl__ci--pending { color: var(--k-accent); }

.k-sl__untrusted {
  flex-basis: 100%;
  list-style: none;
  margin: 0;
  padding: 0;
}

.k-sl__untrusted-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.35em;

  .k-sl__link { white-space: nowrap; }
}
</style>
