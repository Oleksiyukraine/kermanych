<template>
  <div class="k-find-bar">
    <input
      class="k-find-bar__input"
      type="text"
      spellcheck="false"
      :value="query"
      :placeholder="placeholder ?? t('kit.fileView.find.placeholder')"
      :aria-label="placeholder ?? t('kit.fileView.find.placeholder')"
      @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      @keydown.enter.prevent="emit('step', !$event.shiftKey)"
      @keydown.esc.prevent.stop="emit('close')"
    />
    <KIconButton
      v-if="!plain"
      :title="t('kit.fileView.find.matchCase')"
      :active="!!matchCase"
      :aria-pressed="!!matchCase"
      @click="emit('update:matchCase', !matchCase)"
    >Aa</KIconButton>
    <KIconButton
      v-if="!plain"
      :title="t('kit.fileView.find.wholeWord')"
      :active="!!wholeWord"
      :aria-pressed="!!wholeWord"
      @click="emit('update:wholeWord', !wholeWord)"
    ><span class="k-find-bar__word">ab</span></KIconButton>
    <span class="k-find-bar__count mono" aria-live="polite">{{ count }}</span>
    <KIconButton :title="t('kit.fileView.find.prev')" :disabled="!hasHits" @click="emit('step', false)">↑</KIconButton>
    <KIconButton :title="t('kit.fileView.find.next')" :disabled="!hasHits" @click="emit('step', true)">↓</KIconButton>
    <KIconButton :title="t('kit.fileView.find.close')" @click="emit('close')">✕</KIconButton>
  </div>
</template>

<script setup lang="ts">
// The find bar: the file viewers' (state in composables/useFindInText.ts), the terminal's
// (KTerminalView) and the session browser's — field, match case, whole word, `3 / 12`, ↑ ↓ ✕.
// The viewer focuses the field
// through its `.k-find-bar__input` class. Esc is stopped here too, so a viewer's own Esc (leave full
// screen, close the file) waits for the next one. `plain` drops the match case and whole
// word toggles, for a searcher that has neither (the session browser's find in page).
import { useI18n } from 'vue-i18n';
import KIconButton from './KIconButton.vue';

defineProps<{
  query: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  plain?: boolean;
  count: string;
  hasHits: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{
  'update:query': [value: string];
  'update:matchCase': [value: boolean];
  'update:wholeWord': [value: boolean];
  step: [forward: boolean];
  close: [];
}>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-find-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-find-bar__input {
  flex: 1;
  min-width: 0;
  max-width: 320px;
  height: 26px;
  padding: 0 8px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  outline: none;

  &:focus {
    border-color: var(--k-accent);
  }
}
// «ab» over a rule, as editors mark whole-word search.
.k-find-bar__word {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.k-find-bar__count {
  min-width: 48px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  text-align: center;
  white-space: nowrap;
}
</style>
