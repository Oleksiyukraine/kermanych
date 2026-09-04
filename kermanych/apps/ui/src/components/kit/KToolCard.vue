<template>
  <div class="k-tc">
    <div v-if="entry.intent" class="k-tc__intent">{{ entry.intent }}</div>
    <div v-if="entry.truncatedNote" class="k-tc__warn">{{ entry.truncatedNote }}</div>
    <div class="k-tc__body" :class="{ 'k-tc__body--wrap': wrap }">
      <template v-for="(line, i) in lines" :key="i">
        <div v-if="line.t === 'gap'" class="k-tc__gap">⋯</div>
        <div v-else-if="line.t === 'head'" class="k-tc__head">{{ line.text }}</div>
        <div v-else class="k-tc__line" :class="`k-tc__line--${line.t}`">
          <span class="k-tc__n">{{ line.n ?? '' }}</span>
          <span class="k-tc__s">{{ line.t === 'add' ? '+' : line.t === 'del' ? '−' : line.t === 'hit' ? '›' : '' }}</span>
          <span class="k-tc__tx">{{ line.text }}</span>
        </div>
      </template>
    </div>
    <button v-if="rest > 0" type="button" class="k-tc__more" :disabled="busy" @click="emit('more')">
      {{ busy ? t('kit.toolCard.loading') : t('kit.toolCard.showAll', { count: totalLines }) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolLine, TranscriptEntry } from '@kermanych/core';

// One card body for every tool: the per-tool knowledge already lives in the API's
// reducers, so this component only paints classified lines.
const props = defineProps<{
  entry: Extract<TranscriptEntry, { kind: 'tool' }> & { truncatedNote?: string };
  lines: ToolLine[];
  totalLines: number;
  busy?: boolean;
}>();
const emit = defineEmits<{ more: [] }>();

const { t } = useI18n();

// A clipped diff hides the change itself, so edit/write wrap with a hanging indent.
const wrap = computed(() => props.entry.tool === 'edit' || props.entry.tool === 'write');
const rest = computed(() => props.totalLines - props.lines.length);
</script>

<style scoped lang="scss">
.k-tc { margin: 2px 0 8px 17px; padding: 5px 0 5px 10px; border-left: 1px solid var(--k-line-strong); }
.k-tc__intent { font-family: var(--k-font-ui); font-size: 12px; font-style: italic; color: var(--k-muted); }
.k-tc__warn { font-family: var(--k-font-mono); font-size: 10.5px; color: var(--k-accent); margin-top: 3px; }
.k-tc__body { margin-top: 5px; padding: 4px 0; background: var(--k-surface); border-radius: var(--k-r); }
.k-tc__line { display: flex; font-family: var(--k-font-mono); font-size: 11.5px; line-height: 1.5; white-space: pre; overflow: hidden; }
.k-tc__n { flex: none; width: 34px; padding-right: 6px; text-align: right; color: var(--k-line-strong); }
.k-tc__s { flex: none; width: 11px; text-align: center; }
.k-tc__tx { flex: 1; overflow: hidden; text-overflow: ellipsis; color: var(--k-muted); }
.k-tc__line--add { background: color-mix(in srgb, var(--k-diff-add) 9%, transparent); }
.k-tc__line--add .k-tc__s, .k-tc__line--add .k-tc__tx { color: var(--k-diff-add); }
.k-tc__line--del { background: color-mix(in srgb, var(--k-diff-del) 8%, transparent); }
.k-tc__line--del .k-tc__s, .k-tc__line--del .k-tc__tx { color: var(--k-diff-del); }
.k-tc__line--hit .k-tc__tx { color: var(--k-text); }
.k-tc__line--hit .k-tc__s { color: var(--k-accent); }
/* 45px = the 34px gutter (border-box, padding included) + the 11px sign cell, so a
   wrapped continuation lands under the text it continues. */
.k-tc__body--wrap .k-tc__line { display: block; padding-left: 45px; text-indent: -45px; white-space: pre-wrap; word-break: break-word; }
.k-tc__body--wrap .k-tc__n { display: inline-block; width: 34px; }
.k-tc__body--wrap .k-tc__s { display: inline-block; width: 11px; }
.k-tc__body--wrap .k-tc__tx { display: inline; overflow: visible; text-overflow: clip; }
/* Holds `⋯`, a glyph and not text, so it takes the icon scale while `.k-tc__head` and
   `.k-tc__more` beside it stay on the 11px mono type they actually set. */
.k-tc__gap { padding-left: 34px; font-family: var(--k-font-mono); font-size: var(--k-icon-xs); line-height: 1.4; color: var(--k-line-strong); }
.k-tc__head { padding: 4px 0 1px 6px; font-family: var(--k-font-mono); font-size: 11px; color: var(--k-text); }
.k-tc__more { margin-top: 5px; padding: 0; background: transparent; border: none; font-family: var(--k-font-mono); font-size: 11px; color: var(--k-accent); cursor: pointer; }
.k-tc__more:disabled { color: var(--k-muted); cursor: default; }
</style>
