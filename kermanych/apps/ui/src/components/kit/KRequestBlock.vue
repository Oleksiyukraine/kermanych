<template>
  <section class="k-rb">
    <button v-if="block.request" type="button" class="k-rb__head" :aria-expanded="shown" @click="onHead">
      <span class="k-rb__bar" aria-hidden="true"></span>
      <span class="k-rb__tx" :class="{ 'k-rb__tx--full': shown }">{{ block.request.text || '(вкладення)' }}</span>
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
            <KToolRow v-for="m in item.members" :key="m.id" :entry="m" :session-id="sessionId" />
          </div>
        </div>
        <KLogBlock
          v-else-if="!item.muted || expandAll"
          :entry="item.entry"
          :session-id="sessionId"
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

const props = defineProps<{ block: ChatBlock; sessionId: string; open: boolean; expandAll: boolean }>();

const open = ref(props.open);
// The live block is the open one: when a new request arrives this block stops being
// last, `open` flips to false and the finished work collapses to its summary row.
// A manual toggle survives, because the prop only changes when the tail moves.
watch(() => props.open, (v) => { open.value = v; });

// The header is a button wrapping the operator's own prose, and a drag-select that ends
// inside it fires `click` too — collapsing the block would throw away the text just
// selected. Only a selection touching THIS header suppresses the toggle: selecting a line
// in a tool card is a workflow of its own here, and it must not deaden every header on the
// page. `detail === 0` marks keyboard activation, which is never suppressed.
function onHead(e: MouseEvent): void {
  const sel = window.getSelection();
  const host = e.currentTarget as HTMLElement;
  const inHead =
    !!sel && !sel.isCollapsed && !!sel.toString().trim() &&
    ((!!sel.anchorNode && host.contains(sel.anchorNode)) || (!!sel.focusNode && host.contains(sel.focusNode)));
  if (e.detail > 0 && inHead) return;
  open.value = !open.value;
}

// A block with no request — buildChatBlocks' "pre" block, holding startup notices and
// anything before the first user message — renders no header, so nothing could ever
// expand it. Its rows are always shown rather than silently unreachable.
const shown = computed(() => !props.block.request || open.value);

const opened = ref(new Set<number>());
function toggle(i: number): void {
  const next = new Set(opened.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  opened.value = next;
}

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

// Whole seconds below a minute, then whole minutes. A sub-second span gets a floor marker
// instead of `0 с`, which would claim the block took no time at all.
function dur(ms: number): string {
  if (ms < 1000) return '<1 с';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
}

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
    // Sub-cent spend is real spend: rounding it to `$0.00` would assert the turn was free.
    s.cost >= 0.005 ? `$${s.cost.toFixed(2)}` : s.cost ? '<$0.01' : '',
  ].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-rb + .k-rb { margin-top: 10px; }
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
   collapsed one-liner stays unselectable, which keeps a stray drag from eating its click. */
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
