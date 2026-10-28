<script setup lang="ts">
// One file opened read-only from the file-manager dock. The api hands over the whole body, or a flag
// for a binary/oversized blob; this paints it with highlight.js. Fetch state lives in the
// props — the same split KDiffView uses: the caller owns the request, while the path header
// and the close control stay put through loading, an error and a binary file alike.
//
// With `load` (raw bytes of a repo path), a Markdown/HTML/PDF/image file also gets source /
// split / preview in the header — the same toggle KDiffView carries. A click on an in-repo
// link of a rendered doc comes out as `open`, for the caller to open that file.
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileContent } from '@kermanych/core';
import type { FileDiff } from '../../lib/api';
import { docPreviewKind, initialViewMode, rememberedViewMode, type ViewMode } from '../../lib/doc-preview';
import KCodeView from './KCodeView.vue';
import KDiffRows from './KDiffRows.vue';
import KIcon from './KIcon.vue';
import KDocPreview from './KDocPreview.vue';
import KFullscreenButton from './KFullscreenButton.vue';
import KIconButton from './KIconButton.vue';
import KSplitPanes from './KSplitPanes.vue';
import KViewModeToggle from './KViewModeToggle.vue';

const props = defineProps<{
  path: string;
  file: FileContent | null;
  loading?: boolean;
  error?: string | null;
  maximized?: boolean;
  load?: (path: string) => Promise<Blob>;
  // The file's diff against the session's base: `null` while it loads (or when it could not
  // be read), left out entirely where there is no base to compare with (a project checkout,
  // the docs page) — then there is no ± at all.
  diff?: FileDiff | null | undefined;
  diffLoading?: boolean;
  // Open previewable files rendered rather than on a remembered `source` (the docs page,
  // where files are there to be read).
  rendered?: boolean;
}>();
const emit = defineEmits<{ close: []; toggleMaximize: []; open: [path: string] }>();

const { t } = useI18n();

const previewKind = computed(() => docPreviewKind(props.path));
// Over the reader's size cap the raw route refuses the file too, so there is nothing to render.
const previewable = computed(() => !!props.load && previewKind.value !== null && !props.file?.truncated);
// Per view, seeded from the remembered mode; a pick here becomes the remembered one, so the
// next file (or this one, docked ↔ full screen) opens the same way.
const mode = ref<ViewMode>(initialViewMode(previewKind.value, props.rendered));
// Per file: without `rendered` this is the remembered mode again (a pick already set it), so
// only the PDF/image fall-back moves; with it, every file opens rendered.
watch(() => props.path, () => { mode.value = initialViewMode(previewKind.value, props.rendered); });
// Only a click is remembered — not a PDF's automatic fall-back to `preview`.
function pickMode(m: ViewMode): void {
  mode.value = m;
  rememberedViewMode.value = m;
}
const shownMode = computed<ViewMode>(() => (previewable.value ? mode.value : 'source'));
// ± — the file's changes in place of its text. Always on screen where a diff applies, so an
// unchanged file says so through a disabled button and its tip rather than by the button
// going missing. Off for each newly opened file: this viewer is for reading files, and a diff
// is something to ask for here.
const diffApplies = computed(() => props.diff !== undefined);
const hasChanges = computed(() => !!props.diff && !props.diff.binary && props.diff.hunks.length > 0);
const diffOn = ref(false);
watch(() => props.path, () => { diffOn.value = false; });
const shownDiff = computed(() => (diffOn.value && hasChanges.value ? props.diff : null));
const diffTip = computed(() => {
  if (props.diffLoading) return t('kit.diff.loading');
  if (props.diff?.binary) return t('kit.diff.binary');
  if (!hasChanges.value) return t('kit.diff.noChangesTip');
  return diffOn.value ? t('kit.diff.hideDiff') : t('kit.diff.showDiff');
});

// Keyboard scrolling goes to the focused element, and the click that opened this file left
// focus on a tree row the viewer now covers. So the viewer takes focus itself — its scroller
// (code, diff or rendered page) — when a newly opened file's body lands, when the mode or ±
// swaps it, on the docked ↔ full-screen switch (the ⤢ that did it is not a scroller), and on mount.
// Only from where an open leaves focus, though: nowhere, a file-tree row, or this viewer. A
// re-read of the open file (a pull, an agent's edit) does not count as an open, and a file
// restored in the background never takes focus from the list or composer in use.
const viewEl = ref<HTMLElement | null>(null);
function focusBody(): void {
  void nextTick(() => {
    const active = document.activeElement;
    const free = !active || active === document.body || !!viewEl.value?.contains(active) || !!active.closest('.k-file-tree');
    if (free) viewEl.value?.querySelector<HTMLElement>('.k-scroller')?.focus({ preventScroll: true });
  });
}
// The file whose body last took focus, so a re-read of it does not take it again.
let focusedPath = props.file ? props.path : null;
onMounted(focusBody);
watch(
  () => (props.file ? props.path : null),
  (p) => {
    if (!p || p === focusedPath) return;
    focusedPath = p;
    focusBody();
  },
);
watch([shownMode, shownDiff, () => props.maximized], focusBody);

// The body already fetched for the source view; the preview reads it instead of the bytes.
const previewText = computed(() =>
  props.file && !props.file.binary && !props.file.truncated ? props.file.content : null,
);
</script>

<template>
  <section ref="viewEl" class="k-file-view" :aria-label="t('kit.fileView.fileLabel', { path })">
    <header class="k-file-view__head">
      <span class="k-file-view__path mono">{{ path }}</span>
      <span class="k-file-view__spacer"></span>
      <KIconButton
        v-if="diffApplies"
        :title="diffTip"
        :active="!!shownDiff"
        :aria-pressed="!!shownDiff"
        :disabled="!hasChanges"
        @click="diffOn = !diffOn"
      ><KIcon class="k-file-view__icon" name="viewDiff" /></KIconButton>
      <span v-if="diffApplies && previewable" class="k-file-view__sep" aria-hidden="true"></span>
      <KViewModeToggle v-if="previewable" :model-value="mode" @update:model-value="pickMode" />
      <KFullscreenButton :on="!!maximized" @click="emit('toggleMaximize')" />
      <KIconButton :title="t('kit.fileView.close')" @click="emit('close')">✕</KIconButton>
    </header>

    <KSplitPanes
      class="k-file-view__panes"
      :show="shownMode === 'source' ? 'start' : shownMode === 'preview' ? 'end' : 'both'"
      storage-key="kermanych.fileView.split"
    >
      <template #start>
        <div class="k-file-view__source">
          <p v-if="loading" class="k-file-view__msg mono">{{ t('kit.fileView.loading') }}</p>
          <p v-else-if="error" class="k-file-view__msg k-file-view__msg--error mono" role="alert">{{ error }}</p>
          <p v-else-if="file?.binary" class="k-file-view__msg mono">{{ t('kit.fileView.binary') }}</p>
          <p v-else-if="file?.truncated" class="k-file-view__msg mono">{{ t('kit.fileView.tooLarge') }}</p>
          <div v-else-if="shownDiff" class="k-file-view__body k-file-view__body--diff k-scroller" tabindex="0">
            <KDiffRows :diff="shownDiff" />
          </div>
          <div v-else-if="file" class="k-file-view__body k-scroller" tabindex="0">
            <KCodeView :path="path" :text="file.content" />
          </div>
        </div>
      </template>
      <template #end>
        <KDocPreview v-if="load" :path="path" :load="load" :text="previewText" @open="emit('open', $event)" />
      </template>
    </KSplitPanes>
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
// The ± and its hairline, sized as in KDiffView's header.
.k-file-view__icon { --k-icon-size: var(--k-icon-md); }
.k-file-view__sep {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--k-line-strong);
}
// The diff's column heads stick to the body's top edge, so no padding above them.
.k-file-view__body--diff { padding-block: 0; }
.k-file-view__panes {
  flex: 1;
}
.k-file-view__source {
  display: flex;
  flex-direction: column;
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
  padding-block: var(--k-sp-2);
  overflow: auto;
  flex: 1;
  min-height: 0;
}
</style>
