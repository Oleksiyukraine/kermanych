<template>
  <div
    class="k-session-card-host"
    :class="{
      'k-session-card-host--fork': fork,
      'k-session-card-host--fork-lit': fork && selected,
      'k-session-card-host--actions': !!$slots.actions,
    }"
  >
    <button
      type="button"
      class="k-session-card"
      :class="{ 'k-session-card--selected': selected }"
      @click="$emit('click')"
    >
      <div class="k-session-card__top">
        <span
          class="k-session-card__label"
          :class="branch ? 'k-session-card__label--branch' : 'k-session-card__label--title'"
        >{{ branch || title }}</span>
        <span class="k-session-card__time">{{ time }}</span>
      </div>
      <div class="k-session-card__status">
        <KStatusDot :status="status" />
        <span v-if="statusLine" class="k-session-card__status-line">{{ statusLine }}</span>
      </div>
      <!-- what is running and what it has cost — absent whenever we know neither -->
      <div v-if="model || spend" class="k-session-card__meta mono">
        <span v-if="model" class="k-session-card__model">{{ model }}</span>
        <span v-if="model && spend">·</span>
        <span v-if="spend" class="k-session-card__spend">{{ spend }}</span>
      </div>
    </button>
    <!-- Row actions live OUTSIDE the card's <button> — a button inside a button is invalid
         HTML, and Chromium drops the inner one's activation. They are laid over the gutter
         the host reserves for them, so revealing them never reflows the card. -->
    <div v-if="$slots.actions" class="k-session-card__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionStatus, Usage } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import { tokens, usageTokens, usd } from '../../lib/format';

// Session summary card: branch + time header, a status row pairing the status dot with a
// short status line, and the accounting line — which model is running and what it has
// consumed. Selected / hover lift the card with a subtle surface fill.
//
// `fork` marks the card as a BRANCH of the card above it — a discussion or review session
// forked off a parent agent's conversation. It is not decoration: the fork is a child in a
// one-level tree, and without the elbow the list would show it as one more independent
// agent that merely happens to sit there. The list is expected to keep a fork directly
// under its parent, alone with its siblings in one container, and to leave `--k-fork-gap`
// (default `--k-sp-2`) as the vertical gap between them — the spine crosses exactly that.
//
// The `actions` slot holds per-row controls (KIconButton), revealed on hover or keyboard
// focus. Fill it only for rows that HAVE an action: its mere presence reserves the gutter
// on every card that passes it, and an always-empty gutter is a promise the card breaks.
// Handlers inside it must `@click.stop`, or the card's own click fires too.
const props = withDefaults(
  defineProps<{
    branch: string;
    title?: string;
    time: string;
    status: SessionStatus;
    statusLine?: string;
    // The session's lifetime accounting. Absent until the agent has taken a turn we
    // counted, and absent it stays: the line disappears rather than claim `0 ток · $0.00`.
    usage?: Usage | undefined;
    model?: string | undefined;
    selected?: boolean;
    fork?: boolean;
  }>(),
  { selected: false, fork: false },
);

defineEmits<{ click: [] }>();

// Same construction as the panel's status row: the facts we have, `·`-joined, so a missing
// one leaves no dangling separator behind.
const spend = computed(() => {
  const u = props.usage;
  if (!u) return '';
  return [`${tokens(usageTokens(u))} ток`, usd(u.cost)].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-session-card {
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
  transition: background 0.12s ease;

  &:hover {
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--k-accent);
  }
}

.k-session-card--selected {
  background: var(--k-surface2);
}

// ── Row actions ───────────────────────────────────────────────────────────────────────
// A card that carries actions reserves a gutter for them for its whole life, so the
// cluster appearing on hover never nudges the branch or the time it sits beside. The
// cluster is hidden with `opacity` rather than `display`/`visibility`: it stays in the
// tab order, and `:focus-within` reveals it for a keyboard operator who never hovers.
.k-session-card-host--actions {
  --k-card-actions: 36px;

  .k-session-card {
    padding-right: calc(var(--k-sp-3) + var(--k-card-actions));
  }
}

.k-session-card__actions {
  position: absolute;
  right: var(--k-sp-3);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.k-session-card-host:hover > .k-session-card__actions,
.k-session-card-host:focus-within > .k-session-card__actions {
  opacity: 1;
  pointer-events: auto;
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
.k-session-card-host--fork:not(:last-child)::before {
  height: calc(100% + var(--k-fork-gap, var(--k-sp-2)));
}

// While the fork is the open session, its tie to the parent is what the operator is
// looking for: light it.
.k-session-card-host--fork-lit::before,
.k-session-card-host--fork-lit::after {
  background: var(--k-accent);
}

// A fork carries no branch, so it shows its name — which must not outshout the parent's
// own label above it.
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

.k-session-card__time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  flex: none;
}

.k-session-card__status {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.k-session-card__status-line {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// The accounting line, one notch quieter than the status line: it is reference, not news.
// A long model id is the only field here that survives clipping with its meaning intact,
// so it is the one that shrinks; the figure it cost must always be readable in full.
.k-session-card__meta {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  white-space: nowrap;
  overflow: hidden;
}

.k-session-card__model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.k-session-card__spend {
  flex: none;
}
</style>
