<script setup lang="ts">
// One file opened read-only from the file-manager dock. The api hands over the whole body, or a flag
// for a binary/oversized blob; this paints it with highlight.js. Fetch state lives in the
// props — the same split KDiffView uses: the caller owns the request, while the path header
// and the close control stay put through loading, an error and a binary file alike.
//
// With `load` (raw bytes of a repo path), a Markdown/HTML/PDF file also gets source / split /
// preview in the header — the same toggle KDiffView carries.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import type { FileContent } from '@kermanych/core';
import { docPreviewKind, initialViewMode, rememberedViewMode, type ViewMode } from '../../lib/doc-preview';
import KDocPreview from './KDocPreview.vue';
import KIconButton from './KIconButton.vue';
import KViewModeToggle from './KViewModeToggle.vue';

const props = defineProps<{
  path: string;
  file: FileContent | null;
  loading?: boolean;
  error?: string | null;
  maximized?: boolean;
  load?: (path: string) => Promise<Blob>;
}>();
const emit = defineEmits<{ close: []; toggleMaximize: [] }>();

const { t } = useI18n();

const previewKind = computed(() => docPreviewKind(props.path));
// Over the reader's size cap the raw route refuses the file too, so there is nothing to render.
const previewable = computed(() => !!props.load && previewKind.value !== null && !props.file?.truncated);
// Per view, seeded from the remembered mode; a pick here becomes the remembered one, so the
// next file (or this one, docked ↔ full screen) opens the same way.
const mode = ref<ViewMode>(initialViewMode(previewKind.value));
watch(previewKind, (k) => { mode.value = initialViewMode(k); });
// Only a click is remembered — not a PDF's automatic fall-back to `preview`.
function pickMode(m: ViewMode): void {
  mode.value = m;
  rememberedViewMode.value = m;
}
const shownMode = computed<ViewMode>(() => (previewable.value ? mode.value : 'source'));
// The body already fetched for the source view; the preview reads it instead of the bytes.
const previewText = computed(() =>
  props.file && !props.file.binary && !props.file.truncated ? props.file.content : null,
);

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
      <KViewModeToggle v-if="previewable" :model-value="mode" @update:model-value="pickMode" />
      <KIconButton
        :title="maximized ? t('kit.fileView.minimize') : t('kit.fileView.maximize')"
        @click="emit('toggleMaximize')"
      >{{ maximized ? '⤡' : '⤢' }}</KIconButton>
      <KIconButton :title="t('kit.fileView.close')" @click="emit('close')">✕</KIconButton>
    </header>

    <div class="k-file-view__panes" :class="`k-file-view__panes--${shownMode}`">
      <div v-if="shownMode !== 'preview'" class="k-file-view__source">
        <p v-if="loading" class="k-file-view__msg mono">{{ t('kit.fileView.loading') }}</p>
        <p v-else-if="error" class="k-file-view__msg k-file-view__msg--error mono" role="alert">{{ error }}</p>
        <p v-else-if="file?.binary" class="k-file-view__msg mono">{{ t('kit.fileView.binary') }}</p>
        <p v-else-if="file?.truncated" class="k-file-view__msg mono">{{ t('kit.fileView.tooLarge') }}</p>
        <pre v-else-if="file" class="k-file-view__body"><code v-if="highlighted" class="hljs" v-html="highlighted"></code><code v-else class="hljs">{{ file.content }}</code></pre>
      </div>
      <KDocPreview
        v-if="shownMode !== 'source' && load"
        class="k-file-view__preview"
        :path="path"
        :load="load"
        :text="previewText"
      />
    </div>
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
.k-file-view__panes {
  display: flex;
  flex: 1;
  min-height: 0;
}
.k-file-view__source,
.k-file-view__preview {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
.k-file-view__source {
  display: flex;
  flex-direction: column;
}
.k-file-view__panes--split .k-file-view__preview {
  border-left: 1px solid var(--k-line);
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
