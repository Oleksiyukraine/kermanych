<script setup lang="ts">
// The conversation on the phone (decision 3: «the live conversation»). Readable rather than
// complete: the operator's and the agent's text with their line breaks and fenced code in
// monospace, tool calls as one compact row each, notices, thinking folded behind «думав…»,
// `turn` rows (model, tokens, cost) skipped. Every string goes through text interpolation —
// there is no `v-html` here, so nothing an agent writes can become markup on the phone.
import { reactive } from "vue";
import type { TranscriptEntry } from "@kermanych/core";
import { t } from "../lib/i18n";
import { isInlineImage, splitFences, type TextPart } from "../lib/text";

defineProps<{ entries: TranscriptEntry[] }>();

/** Thinking entries the operator opened. */
const open = reactive(new Set<string>());
// Entries are replaced, never mutated, when they change (store.applyTranscriptEvent), so the
// split of an unchanged reply is kept per entry object instead of redone on every live event.
const parts = new WeakMap<TranscriptEntry, TextPart[]>();
function partsOf(e: TranscriptEntry & { text: string }): TextPart[] {
  let out = parts.get(e);
  if (!out) parts.set(e, (out = splitFences(e.text)));
  return out;
}

function toggle(id: string): void {
  if (open.has(id)) open.delete(id);
  else open.add(id);
}
</script>

<template>
  <ol class="log">
    <template v-for="e in entries" :key="e.id">
      <li v-if="e.kind === 'user_text'" class="log__user">
        <div v-if="e.text" class="log__bubble">{{ e.text }}</div>
        <div v-if="e.images?.length" class="log__images">
          <template v-for="(src, i) in e.images" :key="i">
            <img v-if="isInlineImage(src)" :src="src" class="log__image" :alt="t('session.photoAlt')" />
          </template>
        </div>
      </li>

      <li v-else-if="e.kind === 'assistant_text'" class="log__assistant">
        <template v-for="(part, i) in partsOf(e)" :key="i">
          <pre v-if="part.kind === 'code'" class="log__code"><code>{{ part.text }}</code></pre>
          <p v-else class="log__text">{{ part.text }}</p>
        </template>
      </li>

      <li v-else-if="e.kind === 'assistant_thinking'" class="log__thinking">
        <button type="button" class="log__think-toggle" :aria-expanded="open.has(e.id)" @click="toggle(e.id)">
          {{ open.has(e.id) ? t("session.thinkingHide") : t("session.thinking") }}
        </button>
        <p v-if="open.has(e.id)" class="log__think-text">{{ e.text }}</p>
      </li>

      <li v-else-if="e.kind === 'tool'" class="log__tool" :class="`log__tool--${e.status}`">
        <span v-if="e.status === 'pending'" class="spinner log__tool-mark" aria-hidden="true" />
        <span v-else class="log__tool-mark" aria-hidden="true">{{ e.status === "ok" ? "✓" : "✕" }}</span>
        <span class="log__tool-name">{{ e.tool }}</span>
        <span v-if="e.target" class="log__tool-target">{{ e.target }}</span>
        <span v-if="typeof e.stat === 'string'" class="log__tool-stat">{{ e.stat }}</span>
      </li>

      <li v-else-if="e.kind === 'notice'" class="log__notice" :class="`log__notice--${e.level}`">{{ e.text }}</li>
    </template>
  </ol>
</template>

<style scoped>
.log {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
.log__user {
  align-self: flex-end;
  max-width: 88%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--k-sp-1);
}
.log__bubble {
  padding: var(--k-sp-2) var(--k-sp-3);
  border-radius: var(--k-r-lg) var(--k-r-lg) var(--k-r-sm) var(--k-r-lg);
  background: var(--k-surface2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log__images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--k-sp-1);
}
.log__image {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--k-r);
}
.log__assistant {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  min-width: 0;
}
.log__text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log__code {
  margin: 0;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-radius: var(--k-r);
  background: var(--k-canvas);
  border: var(--k-rule-thin) solid var(--k-line);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.log__thinking {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-1);
}
.log__think-toggle {
  min-height: 32px;
  padding: 0 var(--k-sp-2);
  margin-left: calc(-1 * var(--k-sp-2));
  border: 0;
  background: none;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
  font-style: italic;
  cursor: pointer;
}
.log__think-text {
  margin: 0;
  padding-left: var(--k-sp-3);
  border-left: var(--k-rule-strong) solid var(--k-line-strong);
  color: var(--k-muted);
  font-size: var(--k-fs-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log__tool {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.log__tool-mark {
  width: 14px;
  height: 14px;
  flex: none;
  text-align: center;
  line-height: 14px;
}
.log__tool--ok .log__tool-mark {
  color: var(--k-success);
}
.log__tool--error .log__tool-mark,
.log__tool--error .log__tool-name {
  color: var(--k-danger);
}
.log__tool-name {
  flex: none;
  color: var(--k-text);
}
.log__tool-target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log__tool-stat {
  flex: none;
  color: var(--k-faint);
}
.log__notice {
  align-self: center;
  max-width: 92%;
  padding: var(--k-sp-1) var(--k-sp-3);
  border-radius: var(--k-r);
  background: var(--k-surface);
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log__notice--warn {
  color: var(--k-warning);
}
.log__notice--error {
  color: var(--k-danger);
}
</style>
