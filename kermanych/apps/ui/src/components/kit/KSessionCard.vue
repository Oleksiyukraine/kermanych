<template>
  <div
    class="k-session-card-host"
    :class="{
      'k-session-card-host--fork': fork,
      'k-session-card-host--fork-lit': fork && selected,
    }"
  >
    <button
      type="button"
      class="k-session-card"
      :class="{
        'k-session-card--selected': selected,
        'k-session-card--removable': removable,
      }"
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

    <!-- Remove — revealed on hover, and a SIBLING of the card rather than a child: the card
         is itself a <button>, which cannot nest one. Being a sibling is also what makes the
         action unambiguous — the ✕ click never reaches the card, so pressing it deletes the
         row instead of opening whatever the card's own click opens. -->
    <button
      v-if="removable"
      type="button"
      class="k-session-card__remove"
      v-tip="removeTitle"
      :aria-label="removeTitle"
      @click="$emit('remove')"
    >✕</button>
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
// `removable` gives the card a ✕ that appears under the cursor and emits `remove` — for a
// list whose rows are deletable in place, such as the backlog, where the card's own click
// opens an editor and so cannot double as the way out. The glyph's width is RESERVED in the
// top row rather than laid over it: it neither hides the time nor shifts the row when the
// pointer arrives. `removeTitle` names the action for the tooltip and the accessible name —
// pass the row's subject ("Видалити задачу «…»"), since a bare ✕ has no name of its own.
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
    removable?: boolean;
    removeTitle?: string;
  }>(),
  { selected: false, fork: false, removable: false, removeTitle: 'Видалити' },
);

defineEmits<{ click: []; remove: [] }>();

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
  font-size: var(--k-fs-xs);
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
  background: var(--k-surface2);
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
