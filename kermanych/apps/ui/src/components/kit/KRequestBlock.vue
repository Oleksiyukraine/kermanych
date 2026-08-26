<template>
  <section class="k-rb">
    <button
      v-if="block.request"
      type="button"
      class="k-rb__head"
      :aria-expanded="shown"
      @pointerdown="onHeadDown"
      @click="onHead"
    >
      <span class="k-rb__bar" aria-hidden="true"></span>
      <!-- `.trim()`: a whitespace-only request is as empty as a missing one, and would
           otherwise render a blank header line instead of the attachment placeholder. -->
      <span class="k-rb__tx" :class="{ 'k-rb__tx--full': shown }">{{ block.request.text.trim() || '(вкладення)' }}</span>
      <span v-if="!shown" class="k-rb__sum mono">{{ summary }}</span>
      <span v-else class="k-rb__time mono">{{ clock }}</span>
    </button>

    <!-- The operator's attachments. `buildChatBlocks` keeps `user_text` out of `items`, so
         this is the only place they can render; gated on `shown` to keep the collapsed row
         one line, and outside the header because a button may not contain images. -->
    <div v-if="shown && block.request?.images?.length" class="k-rb__imgs">
      <img v-for="(src, n) in block.request.images" :key="n" :src="src" class="k-rb__img" alt="вкладення" />
    </div>

    <template v-if="shown">
      <template v-for="(item, i) in rows" :key="i">
        <div v-if="item.kind === 'group'" class="k-rb__group">
          <button type="button" class="k-rb__grow" :aria-expanded="opened.has(i)" @click="toggle(i)">
            <span class="k-rb__g" :class="`k-rb__g--${item.status}`" role="img" :aria-label="STATUS_LABEL[item.status]">{{ GLYPH[item.status] }}</span>
            <span class="k-rb__gt">{{ item.tool }}</span>
            <span class="k-rb__gtg">{{ item.members.map((m) => m.target).filter(Boolean).join(', ') }}</span>
            <span class="k-rb__gx">×{{ item.members.length }}</span>
            <span class="k-rb__gst">{{ item.stat }}</span>
            <span class="k-rb__gch" aria-hidden="true">{{ opened.has(i) ? '⌄' : '›' }}</span>
          </button>
          <div v-if="opened.has(i)" class="k-rb__members">
            <KToolRow v-for="m in item.members" :key="m.id" :entry="m" :session-id="sessionId" :expand-all="expandAll" />
          </div>
        </div>
        <KLogBlock
          v-else-if="!item.muted || expandAll.on"
          :entry="item.entry"
          :session-id="sessionId"
          :expand-all="expandAll"
        />
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatBlock, ToolEntry } from '@kermanych/core';
import KLogBlock from './KLogBlock.vue';
import KToolRow from './KToolRow.vue';
import type { ExpandAllCommand } from '../../lib/expand-all';
import { dur } from '../../lib/time';
import { usd } from '../../lib/format';

const props = defineProps<{ block: ChatBlock; sessionId: string; open: boolean; expandAll: ExpandAllCommand }>();

const open = ref(props.open);
// The live block is the open one: when a new request arrives this block stops being
// last, `open` flips to false and the finished work collapses to its summary row.
// A manual toggle survives, because the prop only changes when the tail moves.
watch(() => props.open, (v) => { open.value = v; });

// A block with no request — buildChatBlocks' "pre" block, holding startup notices and
// anything before the first user message — renders no header, so nothing could ever
// expand it. Its rows are always shown rather than silently unreachable.
const shown = computed(() => !props.block.request || open.value);

// The header is a button wrapping the operator's own prose, so a gesture that lands on it
// is either a click (toggle) or a selection (leave the block alone). The question asked is
// "did the pointer travel", not "is something selected": selection state at click time is
// unreliable — mousedown may already have collapsed it — while the drag terminus is not.
// A stationary click therefore always toggles, whatever is selected anywhere on the page,
// and keyboard activation (`detail === 0`) is never suppressed.
//
// Travel only reads as a selection while the block is expanded: `user-select: text` lives
// on `.k-rb__tx--full` alone, so on the collapsed one-liner there is nothing to select and
// a shaky click is only ever a click. Suppressing it there would swallow the operator's
// press for the sake of a selection that cannot happen.
const DRAG_SLOP = 4;
let downX = 0;
let downY = 0;
function onHeadDown(e: PointerEvent): void {
  downX = e.clientX;
  downY = e.clientY;
}
function onHead(e: MouseEvent): void {
  // Double- and triple-click select a word or the whole message; neither is a toggle.
  if (e.detail > 1) return;
  if (shown.value && e.detail > 0 && Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) return;
  open.value = !open.value;
}

const opened = ref(new Set<number>());
function toggle(i: number): void {
  const next = new Set(opened.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  opened.value = next;
}

// The toolbar reaches the coalesced groups too: their members are KToolRow rows that are
// not even rendered while the group is shut, so leaving the set alone would make
// `розгорнути все` a no-op for every grouped call. Written as a command, like `open`
// above, so `стиснути все` also closes a group the operator opened by hand.
// Deliberately NOT applied to `open`: this switch is about detail inside a block, and a
// `стиснути все` that shut the live block would hide the work in flight.
watch(
  () => props.expandAll.seq,
  () => {
    opened.value = props.expandAll.on
      ? new Set(props.block.items.flatMap((it, i) => (it.kind === 'group' ? [i] : [])))
      : new Set();
  },
  { immediate: true },
);

// A coalesced run is only as good as its worst member: `buildChatBlocks` groups
// consecutive read-likes regardless of status, so a hardcoded tick would hide a failed
// read behind a collapsed row. Glyphs and labels are KToolRow's, since the members render
// as KToolRow rows right below and the aggregate must not invent a second vocabulary.
const GLYPH = { pending: '◆', ok: '✓', error: '✗' } as const;
const STATUS_LABEL = { pending: 'виконується', ok: 'завершено', error: 'помилка' } as const;
function gStatus(members: ToolEntry[]): 'pending' | 'ok' | 'error' {
  if (members.some((m) => m.status === 'error')) return 'error';
  if (members.some((m) => m.status === 'pending')) return 'pending';
  return 'ok';
}

// One status per group row: the glyph, its colour class and its label all read the same
// fold, instead of recomputing it three times per render.
const rows = computed(() =>
  props.block.items.map((item) => (item.kind === 'group' ? { ...item, status: gStatus(item.members) } : item)),
);

const clock = computed(() =>
  props.block.request ? new Date(props.block.request.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '',
);

// Five facts, all derived from the block's own entries — see the spec's requirement 8.
// A metric that did not happen renders nothing rather than a zero, so a prose-only answer
// collapses to its duration instead of claiming `0 викликів · 0 файлів`.
const summary = computed(() => {
  const s = props.block.summary;
  return [
    dur(s.ms),
    s.calls ? `${s.calls} викликів` : '',
    s.files ? `${s.files} файлів` : '',
    // Reasoning under a second is latency, not a pause: `summary.thinkMs` sums even the
    // sub-threshold entries that render no chip, and they do not earn one of five slots.
    s.thinkMs >= 1000 ? `роздуми ${dur(s.thinkMs)}` : '',
    usd(s.cost),
  ].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-rb + .k-rb { margin-top: 10px; }
.k-rb { border-radius: var(--k-r-lg); }
.k-rb__head {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
}
.k-rb__head:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
.k-rb__bar { flex: none; width: 2px; align-self: stretch; background: var(--k-accent); }
.k-rb__tx {
  flex: 1; font-family: var(--k-font-ui); font-size: 14px; line-height: 1.5; color: var(--k-text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Collapsed the request is a one-line summary; expanded it is the only copy of the
   operator's message in the log, so it wraps in full like KLogBlock's `.k-log__user`.
   Chrome makes a button's contents unselectable, verified by drag-selecting one, so the
   expanded prose also has to opt back into selection to be readable and copyable — the
   collapsed one-liner stays unselectable, and `onHead`'s drag guard is scoped to match:
   with nothing to select there, travel over the collapsed row is not a selection. */
.k-rb__tx--full { overflow: visible; text-overflow: clip; white-space: pre-wrap; word-break: break-word; user-select: text; }
.k-rb__imgs { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 0 10px; }
.k-rb__img { display: block; max-width: 220px; max-height: 220px; border: 1px solid var(--k-line-strong); }
.k-rb__sum, .k-rb__time { flex: none; font-size: 10.5px; color: var(--k-muted); }
.k-rb__grow {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 0;
  background: transparent; border: none; cursor: pointer; text-align: left;
  font-family: var(--k-font-mono); font-size: 12.5px; line-height: 1.7;
  white-space: nowrap; overflow: hidden; color: var(--k-muted);
}
.k-rb__grow:hover { background: var(--k-surface); }
.k-rb__grow:focus-visible { outline: 1px solid var(--k-accent); outline-offset: -1px; }
.k-rb__g { flex: none; width: 9px; font-size: 10.5px; }
.k-rb__g--pending { color: var(--k-accent); animation: k-rb-pulse 1.4s ease-in-out infinite; }
.k-rb__g--error { color: var(--k-accent); }
/* Scoped `@keyframes` names are hash-rewritten per SFC, so KToolRow's pulse cannot be
   reused by name — this is the same animation, declared locally. */
@keyframes k-rb-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
/* Same fixed column as KToolRow's `.k-tr__t`: the group row sits directly among
   those rows, so its tool name has to land on the same 60px grid — with the same
   ellipsis backstop for names past eight characters. */
.k-rb__gt { flex: none; width: 60px; overflow: hidden; text-overflow: ellipsis; color: var(--k-text); }
.k-rb__gx { flex: none; font-size: 11px; }
.k-rb__gtg { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.k-rb__gst { flex: none; font-size: 11.5px; color: var(--k-text); }
.k-rb__gch { flex: none; width: 10px; text-align: right; font-size: 11px; color: var(--k-line-strong); }
.k-rb__members { padding-left: 17px; }
</style>
