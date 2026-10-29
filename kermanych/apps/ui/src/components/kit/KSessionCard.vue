<template>
  <div
    class="k-session-card-host"
    :class="{
      'k-session-card-host--fork': fork,
      'k-session-card-host--fork-lit': fork && selected,
      'k-session-card-host--fork-continues': fork && forkContinues,
      'k-session-card-host--actions': !!$slots.actions,
    }"
  >
    <button
      type="button"
      class="k-session-card"
      :class="{
        'k-session-card--selected': selected,
        'k-session-card--running': working,
        'k-session-card--removable': removable,
        'k-session-card--pending': pending,
      }"
      :style="working ? { '--k-ring-delay': ringDelay } : undefined"
      :aria-busy="pending || undefined"
      @click="$emit('click')"
    >
      <div class="k-session-card__top">
        <span
          class="k-session-card__label"
          :class="title ? 'k-session-card__label--title' : 'k-session-card__label--branch'"
        >{{ title || branch }}</span>
        <span
          v-if="browsing"
          class="k-session-card__browsing"
          v-tip="t('kit.sessionCard.browsing')"
          :aria-label="t('kit.sessionCard.browsing')"
        >◎</span>
        <span
          v-if="findings"
          class="k-session-card__findings mono"
          v-tip="t('kit.sessionCard.findings', { n: findings })"
          :aria-label="t('kit.sessionCard.findings', { n: findings })"
        >⚑ {{ findings }}</span>
        <KSpinner v-if="pending" :size="10" class="k-session-card__pending" />
        <span class="k-session-card__time">{{ time }}</span>
      </div>
      <!-- The branch under the name, unless it would only repeat it. -->
      <div v-if="title && branch && branch !== title" class="k-session-card__branch mono">{{ branch }}</div>
      <!-- One row, one line, whatever the agent is doing: the status leads (the eye reads it
           first), how the agent works follows, and what it cost waits behind the coins. -->
      <div class="k-session-card__row">
        <span class="k-session-card__status">
          <KStatusDot :status="status" />
          <span v-if="statusLine" v-tip.overflow="statusTip" class="k-session-card__status-line">{{ statusLine }}</span>
        </span>
        <span v-if="harness || deepAnalysis || minion || autoRun || needsDecision || notNeeded" class="k-session-card__marks mono">
          <KHarnessMark v-if="harness" :harness="harness" />
          <KAnalysisMark v-if="deepAnalysis" />
          <KMinionMark v-if="minion" kind="running" />
          <KMinionMark v-else-if="autoRun" kind="allowed" />
          <KDecisionMark v-if="needsDecision" :reason="needsDecision" />
          <KNotNeededMark v-else-if="notNeeded" :reason="notNeeded" />
        </span>
        <span v-if="spend" v-tip="spend" class="k-session-card__spend" role="img" :aria-label="spend">
          <KIcon name="coins" />
        </span>
      </div>
    </button>

    <!-- Remove — revealed on hover, and a SIBLING of the card rather than a child: the card
         is itself a <button>, which cannot nest one. Being a sibling is also what makes the
         action unambiguous — the ✕ click never reaches the card, so pressing it deletes the
         row instead of opening whatever the card's own click opens. -->
    <button
      v-if="removable"
      type="button"
      class="k-session-card__remove"
      v-tip="removeTitleLabel"
      :aria-label="removeTitleLabel"
      :disabled="pending"
      @click="$emit('remove')"
    >✕</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SessionStatus, Usage } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import KHarnessMark from './KHarnessMark.vue';
import KAnalysisMark from './KAnalysisMark.vue';
import KMinionMark from './KMinionMark.vue';
import KDecisionMark from './KDecisionMark.vue';
import KNotNeededMark from './KNotNeededMark.vue';
import KSpinner from './KSpinner.vue';
import KIcon from './KIcon.vue';
import { tokens, usageTokens, usd } from '../../lib/format';
import type { LaunchMode } from '../../lib/native-session';

// Session summary card: the agent's name + time header with its branch under it (the branch
// heads the card only when there is no name), then ONE row: the status dot with a one-line
// status, the marks of how the agent works, and a coins icon whose tooltip holds the model and
// what it consumed. Every row is a single line, so the card keeps its height while the status
// flips between a two-line todo and a one-line tool. Hover and selection lift the card (surface
// fill, sheen, card shadow); the selected card wears a thin accent frame. While an agent works
// (`thinking`/`tool`, the statuses the dot pulses for — not `queued`, which may be an hour in
// the slot queue) light runs around its frame, selected or not: a dimmer ring on the others,
// all rings in one phase so several working agents turn as one rhythm. Reduced motion keeps
// every frame static.
// Spec: docs/specs/2026-10-29-agent-list-cards.md (amends 2026-10-28-hermes-theme-and-depth.md, decision 6).
//
// `fork` marks the card as a BRANCH of the card above it — a discussion or review session
// forked off a parent agent's conversation. It is not decoration: the fork is a child in a
// one-level tree, and without the elbow the list would show it as one more independent
// agent that merely happens to sit there. The list is expected to keep a fork directly
// under its parent, alone with its siblings in one container, and to leave `--k-fork-gap`
// (default `--k-sp-2`) as the vertical gap between them — the spine crosses exactly that.
// A list that cannot keep the siblings in one container (a virtualised one wraps every row)
// passes `forkContinues` on every fork but the last, which `:last-child` would decide there.
//
// `removable` gives the card a ✕ that appears under the cursor and emits `remove` — for a
// list whose rows are deletable in place, such as the backlog, where the card's own click
// opens an editor and so cannot double as the way out. The glyph's width is RESERVED in the
// top row rather than laid over it: it neither hides the time nor shifts the row when the
// pointer arrives. `removeTitle` names the action for the tooltip and the accessible name —
// pass the row's subject ("Видалити задачу «…»"), since a bare ✕ has no name of its own.
//
// `browsing` pulses a ◎ before the time while the session's agent is driving its session
// browser (a browser tool call in the last few seconds) — the board's view of the Браузер
// tab's live dot, so the operator sees which agent is clicking without opening it.
//
// `findings` counts the session's OPEN «Знахідки» — problems its agent reported outside its
// task, waiting for the operator to file or dismiss them. A ⚑ with the number before the time;
// absent at zero.
//
// `deepAnalysis` marks a «Глибокий аналіз» card (KAnalysisMark) in the status row, right
// after the harness: it is HOW this agent works, and it never clips — the status does.
//
// `minion` marks a session «Посіпака» runs, `autoRun` a card it may take (KMinionMark, the same
// shape, a different tooltip); `needsDecision` is the worded reason of a run that stopped on a
// choice for the operator (KDecisionMark), `notNeeded` the evidence of a run that found nothing
// to change (KNotNeededMark; never together with `needsDecision`). All sit with the analysis
// mark, for the same reason: they say how this agent works.
//
// `pending` — an action on this session is waiting for its result (stopped, deleted,
// archived, forked…; stores/pending): the card dims, spins before the time, and its ✕ is blocked.
const props = withDefaults(
  defineProps<{
    branch: string;
    title?: string;
    time: string;
    status: SessionStatus;
    statusLine?: string;
    // The session's lifetime accounting. Absent until the agent has taken a turn we
    // counted, and absent it stays: the tooltip drops it rather than claim `0 ток · $0.00`.
    usage?: Usage | undefined;
    model?: string | undefined;
    // The harness running the session (KHarnessMark). Absent for a card nothing runs yet.
    harness?: LaunchMode | undefined;
    // A «Глибокий аналіз» task or session: the agent interviews before it codes.
    deepAnalysis?: boolean | undefined;
    // Run by «Посіпака».
    minion?: boolean | undefined;
    // A card with «Дозволити автовиконання».
    autoRun?: boolean | undefined;
    // «Потрібне рішення», worded (lib/minion.ts minionReasonText); absent when nothing waits.
    needsDecision?: string | undefined;
    // «Не потрібно», the agent's evidence (lib/minion.ts sessionNotNeededReason); absent otherwise.
    notNeeded?: string | undefined;
    selected?: boolean;
    fork?: boolean;
    forkContinues?: boolean;
    removable?: boolean;
    removeTitle?: string;
    browsing?: boolean;
    findings?: number;
    pending?: boolean | undefined;
  }>(),
  { selected: false, fork: false, forkContinues: false, removable: false, browsing: false, findings: 0, pending: false },
);

defineEmits<{ click: []; remove: [] }>();

const { t } = useI18n();
const removeTitleLabel = computed(() => props.removeTitle ?? t('kit.sessionCard.remove'));
// The statuses the status dot pulses for. Deliberately not `isRunningStatus` (lib/attention),
// which also counts `queued` for the attention marks.
const working = computed(() => props.status === 'thinking' || props.status === 'tool');

// Every ring shares one phase: the arc's angle is pinned to the page clock, so a card that
// starts working joins the rhythm the others are already in instead of starting from 0deg.
// Must match the `k-session-card-ring` duration below.
const RING_MS = 3000;
const ringDelay = ref('0ms');
watch(
  working,
  (w) => {
    if (w) ringDelay.value = `-${Math.round(performance.now() % RING_MS)}ms`;
  },
  { immediate: true },
);

// The status line's full text, for when the row cuts it short. Capped: a backlog card's line
// is its whole description, and the bubble must stay a bubble.
const STATUS_TIP_MAX = 200;
const statusTip = computed(() => {
  const line = props.statusLine ?? '';
  return line.length > STATUS_TIP_MAX ? `${line.slice(0, STATUS_TIP_MAX).trimEnd()}…` : line;
});

// The coins tooltip: the model and what it consumed, `·`-joined, so a missing fact leaves no
// dangling separator behind. Empty when nothing is known — the icon goes with it.
const spend = computed(() => {
  const u = props.usage;
  const parts = [props.model ?? ''];
  if (u) parts.push(t('kit.sessionCard.tokens', { count: tokens(usageTokens(u)) }), usd(u.cost));
  return parts.filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-session-card--pending {
  opacity: 0.6;
  cursor: progress;
}

.k-session-card__pending {
  color: var(--k-muted);
  margin-right: 6px;
}

.k-session-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--k-r-lg);
  padding: var(--k-sp-3);
  cursor: pointer;
  transition: background 0.12s ease, box-shadow 0.12s ease;

  &:hover {
    background: var(--k-grad-raise), var(--k-surface2);
    box-shadow: var(--k-sheen), var(--k-shadow-card-hover);
  }

  &:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--k-accent);
  }
}

.k-session-card--selected {
  background: var(--k-grad-raise), var(--k-surface2);
  box-shadow: var(--k-sheen), var(--k-shadow-card);
}

// The frame: a 1px ring masked out of a gradient fill, so the gradient can move along it.
// The selected card always wears it; a working card wears it too, so the eye finds every
// agent at work without reading dots.
.k-session-card--selected::after,
.k-session-card--running::after {
  content: '';
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--k-accent) 60%, transparent),
    color-mix(in srgb, var(--k-accent) 12%, transparent) 50%,
    color-mix(in srgb, var(--k-accent) 40%, transparent)
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

// A working card that is not the open one: the same ring, quieter, so the selected card
// stays the brightest thing in the list and the others do not compete with it.
.k-session-card--running:not(.k-session-card--selected)::after {
  opacity: 0.5;
}

// Running: one bright arc travels the ring. `--k-ring-angle` is a registered <angle>, so
// the conic gradient interpolates instead of jumping between keyframes. `--k-ring-delay`
// (set by the script from the page clock) puts every card's arc in the same phase.
@property --k-ring-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}

@media (prefers-reduced-motion: no-preference) {
  .k-session-card--running::after {
    background: conic-gradient(
      from var(--k-ring-angle),
      color-mix(in srgb, var(--k-accent) 14%, transparent) 0turn,
      var(--k-accent) 0.1turn,
      color-mix(in srgb, var(--k-accent) 14%, transparent) 0.3turn,
      color-mix(in srgb, var(--k-accent) 14%, transparent) 1turn
    );
    animation: k-session-card-ring 3s linear var(--k-ring-delay, 0ms) infinite;
  }
}

@keyframes k-session-card-ring {
  to { --k-ring-angle: 360deg; }
}

// ── Browsing (the agent drives the session browser) ───────────────────────────────────
.k-session-card__browsing {
  flex: none;
  margin-left: auto;
  color: var(--k-accent);
  font-size: var(--k-icon-xs);
  line-height: 1;
  animation: k-session-card-browsing 1.2s ease-in-out infinite;
}

@keyframes k-session-card-browsing {
  50% { opacity: 0.3; }
}

// ── Open findings (⚑ n) ───────────────────────────────────────────────────────────────
// Same seat as the browsing mark: pushed right against the time. When both show, the ◎
// already took the free space and the ⚑ sits beside it.
.k-session-card__findings {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  line-height: 1;
  color: var(--k-accent);
}

.k-session-card__browsing + .k-session-card__findings {
  margin-left: 0;
}

// ── Remove (✕ on hover) ───────────────────────────────────────────────────────────────
// The control is positioned on the host, so the top row RESERVES its width instead of
// letting it cover the time — the row must not shift, and nothing the card states may be
// occluded by an action. Centring is the same arithmetic as the fork elbow: the card's own
// top padding (12px) plus half the label's line box, less half the control.
.k-session-card--removable .k-session-card__top {
  padding-right: calc(20px + var(--k-sp-2));
}

.k-session-card__remove {
  position: absolute;
  top: var(--k-sp-3);
  right: var(--k-sp-3);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-faint);
  // Glyph-only control, so the icon scale rather than `--k-fs-xs`: this ✕ is `--k-faint`,
  // the quietest colour in the set, and at 11px the two reductions compounded.
  font-size: var(--k-icon-xs);
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease;

  &:hover {
    color: var(--k-text);
  }

  // The control is in the tab order whether or not a pointer is near the card, so focus
  // alone has to reveal it — otherwise the keyboard lands on an invisible button.
  &:focus-visible {
    opacity: 1;
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-session-card-host:hover .k-session-card__remove {
  opacity: 1;
}

// Hovering the ✕ must not read as leaving the card: the card's own `:hover` fill drops the
// moment the cursor crosses onto the sibling control, so for a removable card the fill
// follows the HOST and the row stays lit while it is being acted on.
.k-session-card-host:hover .k-session-card--removable {
  background: var(--k-grad-raise), var(--k-surface2);
  box-shadow: var(--k-sheen), var(--k-shadow-card-hover);
}

// ── Fork (a branch of the card above) ─────────────────────────────────────────────────
// The elbow is drawn by the host, not the card: it has to cross the gap the list leaves
// between the two cards, which the card's own box cannot reach.
.k-session-card-host {
  position: relative;
}

.k-session-card-host--fork {
  // Where the elbow meets the card: the label row's centre — the card's own top padding
  // plus half of the 12px label's line box.
  --k-fork-elbow: 21px;
  --k-fork-trunk: 7px;
  padding-left: 18px;

  &::before,
  &::after {
    content: '';
    position: absolute;
    background: var(--k-line-strong);
  }

  // The spine: starts in the gap above (at the parent card's bottom edge) and drops to
  // the elbow.
  &::before {
    left: var(--k-fork-trunk);
    top: calc(-1 * var(--k-fork-gap, var(--k-sp-2)));
    width: 1px;
    height: calc(var(--k-fork-gap, var(--k-sp-2)) + var(--k-fork-elbow));
  }

  // The stub into the card.
  &::after {
    left: var(--k-fork-trunk);
    top: var(--k-fork-elbow);
    width: calc(18px - var(--k-fork-trunk));
    height: 1px;
  }
}

// Every fork but the last runs its spine on to the next sibling, so several branches of
// one agent read as one bracket instead of a chain hanging off each other.
.k-session-card-host--fork:not(:last-child)::before,
.k-session-card-host--fork-continues::before {
  height: calc(100% + var(--k-fork-gap, var(--k-sp-2)));
}

// While the fork is the open session, its tie to the parent is what the operator is
// looking for: light it.
.k-session-card-host--fork-lit::before,
.k-session-card-host--fork-lit::after {
  background: var(--k-accent);
}

// A fork's name must not outshout the parent's own name above it.
.k-session-card-host--fork .k-session-card__label--title {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.k-session-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
}

.k-session-card__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-session-card__label--branch {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-session-card__label--title {
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

// The branch line: reference under the name, in the quiet mono the branch label always had.
.k-session-card__branch {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-session-card__time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  flex: none;
}

// The one row under the name: status, marks, coins. Only the status line may shrink — the
// marks say how the agent works and the coins are a single glyph, so neither clips. The row
// is as tall as a mark chip (an xs icon in 2px padding) whether or not the card has one, so
// every card of a kind is the same height.
.k-session-card__row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  min-height: calc(var(--k-icon-xs) + 4px);
}

.k-session-card__status {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

// One line, always: a todo that once wrapped to two lines and a tool that took one made the
// card change height mid-run and the list jump. The full text is the tooltip (`v-tip.overflow`).
.k-session-card__status-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.k-session-card__marks {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--k-sp-1);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  white-space: nowrap;
}

.k-session-card__spend {
  flex: none;
  color: var(--k-faint);
  transition: color 0.12s ease;
  --k-icon-size: var(--k-icon-sm);

  &:hover {
    color: var(--k-text);
  }
}
</style>
