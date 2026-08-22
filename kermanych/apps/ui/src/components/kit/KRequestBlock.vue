<template>
  <section class="k-rb">
    <button v-if="block.request" type="button" class="k-rb__head" :aria-expanded="shown" @click="open = !open">
      <span class="k-rb__bar" aria-hidden="true"></span>
      <span class="k-rb__tx">{{ block.request.text }}</span>
      <span v-if="!shown" class="k-rb__sum mono">{{ summary }}</span>
      <span v-else class="k-rb__time mono">{{ clock }}</span>
    </button>

    <template v-if="shown">
      <template v-for="(item, i) in block.items" :key="i">
        <div v-if="item.kind === 'group'" class="k-rb__group">
          <button type="button" class="k-rb__grow" :aria-expanded="opened.has(i)" @click="toggle(i)">
            <span class="k-rb__g" aria-hidden="true">✓</span>
            <span class="k-rb__gt">{{ item.tool }}</span>
            <span class="k-rb__gx">×{{ item.members.length }}</span>
            <span class="k-rb__gtg">{{ item.members.map((m) => m.target).filter(Boolean).join(', ') }}</span>
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
import type { ChatBlock } from '@kermanych/core';
import KLogBlock from './KLogBlock.vue';
import KToolRow from './KToolRow.vue';

const props = defineProps<{ block: ChatBlock; sessionId: string; open: boolean; expandAll: boolean }>();

const open = ref(props.open);
// The live block is the open one: when a new request arrives this block stops being
// last, `open` flips to false and the finished work collapses to its summary row.
// A manual toggle survives, because the prop only changes when the tail moves.
watch(() => props.open, (v) => { open.value = v; });

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

function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
}

const clock = computed(() =>
  props.block.request ? new Date(props.block.request.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '',
);

// Five facts, all derived from the block's own entries — see the spec's requirement 8.
const summary = computed(() => {
  const s = props.block.summary;
  return [
    dur(s.ms),
    `${s.calls} викликів`,
    `${s.files} файлів`,
    s.thinkMs ? `роздуми ${dur(s.thinkMs)}` : '',
    s.cost ? `$${s.cost.toFixed(2)}` : '',
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
