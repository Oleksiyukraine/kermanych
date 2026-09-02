<script setup lang="ts">
// One file opened read-only from the Файли tab. The api hands over the whole body, or a flag
// for a binary/oversized blob; this paints it with highlight.js. Fetch state lives in the
// props — the same split KDiffView uses: the caller owns the request, while the path header
// and the close control stay put through loading, an error and a binary file alike.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import type { FileContent } from '@kermanych/core';
import KIconButton from './KIconButton.vue';

const props = defineProps<{
  path: string;
  file: FileContent | null;
  loading?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

// highlightAuto guesses the language from the body — no extension→language table to keep in
// sync, and it degrades to plain text when it cannot tell. Its output is HTML-escaped by
// hljs, so v-html carries no markup the file's own bytes did not; the v-else branch renders
// the raw body as Vue-escaped text if highlighting produced nothing.
const highlighted = computed(() => {
  const content = props.file?.content;
  if (!content) return '';
  try {
    return hljs.highlightAuto(content).value;
  } catch {
    return '';
  }
});
</script>

<template>
  <section class="k-file-view" :aria-label="t('kit.fileView.fileLabel', { path })">
    <header class="k-file-view__head">
      <span class="k-file-view__path mono">{{ path }}</span>
      <span class="k-file-view__spacer"></span>
      <KIconButton :title="t('kit.fileView.close')" @click="emit('close')">✕</KIconButton>
    </header>

    <p v-if="loading" class="k-file-view__msg mono">{{ t('kit.fileView.loading') }}</p>
    <p v-else-if="error" class="k-file-view__msg k-file-view__msg--error mono" role="alert">{{ error }}</p>
    <p v-else-if="file?.binary" class="k-file-view__msg mono">{{ t('kit.fileView.binary') }}</p>
    <p v-else-if="file?.truncated" class="k-file-view__msg mono">{{ t('kit.fileView.tooLarge') }}</p>
    <pre v-else-if="file" class="k-file-view__body"><code v-if="highlighted" class="hljs" v-html="highlighted"></code><code v-else class="hljs">{{ file.content }}</code></pre>
  </section>
</template>

<style scoped lang="scss">
.k-file-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.k-file-view__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  flex: none;
}
.k-file-view__path {
  font-size: 12px;
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-file-view__spacer {
  flex: 1;
}
.k-file-view__msg {
  padding: var(--k-sp-3);
  color: var(--k-muted);
  font-size: 13px;
  &--error {
    color: var(--k-danger);
  }
}
.k-file-view__body {
  margin: 0;
  padding: var(--k-sp-3);
  overflow: auto;
  flex: 1;
  min-height: 0;
  font-size: 12px;
  line-height: 1.5;

  code {
    background: transparent;
    padding: 0;
    white-space: pre;
  }
}
</style>
