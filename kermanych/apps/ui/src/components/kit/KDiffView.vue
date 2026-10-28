<template>
  <!-- Full screen lifts this same layer over the window without moving it in the DOM
       (useFullscreenPopover), so the section keeps its mode, scroll and loaded preview, and no
       ancestor clip or stacking context can cage it; the host stays in the list so the caller's
       class and spacing keep applying. role="dialog" also parks the session browser's native
       view, which Electron paints above the DOM (useOverlayOpen). -->
  <div class="k-diff-host">
    <div
      ref="layerEl"
      popover="manual"
      :class="maximized ? 'k-diff-overlay' : 'k-diff-inline'"
      :role="maximized ? 'dialog' : undefined"
      :aria-modal="maximized ? 'true' : undefined"
    >
      <section
        ref="sectionEl"
        class="k-diff"
        :class="{ 'k-diff--max': maximized }"
        :aria-label="t('kit.diff.fileChanges', { path })"
      >
        <header class="k-diff__head">
          <span class="k-diff__path mono">{{ path }}</span>
          <span class="k-diff__spacer"></span>
          <span v-if="diff?.truncated" class="k-diff__note mono">
            {{ t('kit.diff.truncated', { count: rowCount }) }}
          </span>
          <KIconButton
            v-if="canPlain"
            :title="diffOn ? t('kit.diff.hideDiff') : t('kit.diff.showDiff')"
            :active="diffOn"
            :aria-pressed="diffOn"
            @click="diffOn = !diffOn"
          ><KIcon class="k-diff__icon" name="viewDiff" /></KIconButton>
          <span v-if="canPlain && previewable" class="k-diff__sep" aria-hidden="true"></span>
          <KViewModeToggle v-if="previewable" :model-value="mode" @update:model-value="pickMode" />
          <KFullscreenButton :on="maximized" @click="maximized = !maximized" />
          <KIconButton :title="t('kit.diff.collapse')" @click="emit('close')">✕</KIconButton>
        </header>

        <KSplitPanes
          class="k-diff__panes"
          :class="`k-diff__panes--${shownMode}`"
          :show="shownMode === 'source' ? 'start' : shownMode === 'preview' ? 'end' : 'both'"
          storage-key="kermanych.fileView.split"
        >
          <template #start>
            <div class="k-diff__source">
              <!-- Diff off: the whole current file, highlighted, read through `load`. -->
              <template v-if="!showDiff">
                <div v-if="plainPhase === 'skeleton'" class="k-diff__pad">
                  <KSkeleton variant="lines" :rows="6" />
                </div>
                <template v-else-if="plainPhase === 'blank'"></template>
                <p v-else-if="plainError" class="k-diff__msg k-diff__msg--error mono" role="alert">{{ plainError }}</p>
                <p v-else-if="plainBinary" class="k-diff__msg mono">{{ t('kit.diff.binary') }}</p>
                <div v-else class="k-diff__body k-scroller" tabindex="0">
                  <KCodeView :path="path" :text="plainText" />
                </div>
              </template>
              <p v-else-if="loading" class="k-diff__msg mono">{{ t('kit.diff.loading') }}</p>
              <p v-else-if="error" class="k-diff__msg k-diff__msg--error mono" role="alert">{{ error }}</p>
              <p v-else-if="diff?.binary" class="k-diff__msg mono">{{ t('kit.diff.binary') }}</p>
              <p v-else-if="!diff?.hunks.length" class="k-diff__msg mono">{{ t('kit.diff.noChanges') }}</p>
              <div v-else class="k-diff__body k-scroller" tabindex="0">
                <KDiffRows :diff="diff" />
              </div>
            </div>
          </template>
          <template #end>
            <KDocPreview
              v-if="load"
              class="k-diff__preview"
              :path="path"
              :load="load"
              :refresh-key="diff"
            />
          </template>
        </KSplitPanes>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
// One changed file, side by side: the original on the left, the session's version on the
// right. The api hands over rows already paired (apps/api/src/worktree/split-diff.ts), so
// this component only paints them — no diffing here.
//
// Fetch state lives in the props rather than in the component: the caller owns the request
// (and its refresh while the agent keeps editing), while the path + collapse control stay
// visible through loading, an error and a binary file alike.
//
// A Markdown/HTML/PDF file also has a rendered form: with `load` (raw bytes of a repo path)
// the header offers source / split / preview (KViewModeToggle), and the preview re-reads
// whenever the caller refreshes the diff.
//
// The diff itself is optional: with `load`, the ± button swaps the paired rows for the whole
// current file, highlighted — the file as it reads now rather than what changed in it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFullscreenPopover } from '../../composables/useFullscreenPopover';
import { useLoadPhase } from '../../composables/useLoadPhase';
import type { FileDiff } from '../../lib/api';
import { diffShown, docPreviewKind, initialViewMode, rememberedViewMode, type ViewMode } from '../../lib/doc-preview';
import KCodeView from './KCodeView.vue';
import KDiffRows from './KDiffRows.vue';
import KDocPreview from './KDocPreview.vue';
import KFullscreenButton from './KFullscreenButton.vue';
import KIcon from './KIcon.vue';
import KIconButton from './KIconButton.vue';
import KSkeleton from './KSkeleton.vue';
import KSplitPanes from './KSplitPanes.vue';
import KViewModeToggle from './KViewModeToggle.vue';

const { t } = useI18n();

const props = defineProps<{
  path: string;
  diff: FileDiff | null;
  loading?: boolean;
  error?: string | null;
  load?: (path: string) => Promise<Blob>;
  // Open already full screen — a caller restoring the view after a reload. Changes are
  // reported through `update:maximized` so the caller can remember them.
  startMaximized?: boolean;
}>();

const emit = defineEmits<{ close: []; 'update:maximized': [on: boolean] }>();

const previewKind = computed(() => docPreviewKind(props.path));
// A deleted file has no session version left to render: every row is original-only.
const deleted = computed(() => {
  const d = props.diff;
  return !!d && !d.binary && d.hunks.length > 0 && d.hunks.every((h) => h.rows.every((r) => !r.new));
});
const previewable = computed(() => !!props.load && previewKind.value !== null && !deleted.value);
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

// Diff off needs the file's current text: a binary blob has none and a deleted file has no
// current version, so for those the diff is the only view and the button is not offered.
// The choice itself is shared and remembered (lib/doc-preview.ts), not per file.
const diffOn = diffShown;
const canPlain = computed(() => !!props.load && !props.diff?.binary && !deleted.value);
const showDiff = computed(() => diffOn.value || !canPlain.value);

const plainText = ref('');
const plainBinary = ref(false);
const plainError = ref<string | null>(null);
const plainFor = ref<string | null>(null);
const plainPhase = useLoadPhase(() => plainFor.value !== props.path);
let plainRun = 0;

async function loadPlain(): Promise<void> {
  const load = props.load;
  if (!load) return;
  const run = ++plainRun;
  const path = props.path;
  try {
    const text = await (await load(path)).text();
    if (run !== plainRun) return;
    plainBinary.value = text.slice(0, 8000).includes('\0');
    plainText.value = plainBinary.value ? '' : text;
    plainError.value = null;
  } catch (e) {
    if (run !== plainRun) return;
    // The raw route answers 404 for a file over its 4 MB cap as well as a missing one.
    const msg = e instanceof Error ? e.message : String(e);
    plainError.value = /not found/i.test(msg) ? t('kit.diff.fileUnavailable') : msg;
  } finally {
    if (run === plainRun) plainFor.value = path;
  }
}

// Re-read on every diff refresh, as the preview does: the agent may still be editing. The
// text already on screen stays until the new one lands, so a refresh never blanks the pane.
watch(
  [showDiff, () => props.diff, () => props.path],
  ([on], prev) => {
    if (props.path !== prev?.[2]) plainFor.value = null;
    if (!on) void loadPlain();
  },
  // Immediate: a file opened while the remembered choice is «off» must read its text at once.
  { immediate: true },
);

// Full screen. Escape drops back into the list, listening only while the overlay is up so it
// never steals the key from anything else (the same rule as KFileManager's viewer). Escape
// pressed inside a focused preview frame stays in that frame; the collapse button still works.
const maximized = ref(!!props.startMaximized);
const layerEl = ref<HTMLElement | null>(null);
useFullscreenPopover(layerEl, maximized);
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  maximized.value = false;
}
// Keyboard scrolling goes to the focused element; the ⤢ button that opened full screen is
// not inside a scroller. Each switch hands focus to the block's scroller (diff, file or page).
const sectionEl = ref<HTMLElement | null>(null);
watch(maximized, (on, was) => {
  if (on) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
  if (was !== undefined) emit('update:maximized', on);
  void nextTick(() => {
    sectionEl.value?.querySelector<HTMLElement>('.k-scroller')?.focus({ preventScroll: !on });
  });
}, { immediate: true });
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// Only shown next to the truncation note, where "перші N" has to name what is on screen.
const rowCount = computed(() =>
  (props.diff?.hunks ?? []).reduce((n, h) => n + h.rows.length, 0),
);
</script>

<style scoped lang="scss">
.k-diff {
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-bg);
  overflow: hidden;
}

// Closed, the popover box is dissolved; `color` still inherits through it, so the UA's
// CanvasText is undone too.
.k-diff-inline { display: contents; color: inherit; }
// Open: the whole window, edge to edge, as KFileManager's full-screen viewer.
.k-diff-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  display: flex;
  color: inherit;
  background: var(--k-bg);
}
.k-diff--max {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 0;
  border-radius: 0;

  // The fixed 60vh heights are for the inline block; full screen fills the overlay instead.
  .k-diff__panes {
    flex: 1;
    min-height: 0;
    height: auto;
  }
  .k-diff__body {
    flex: 1;
    min-height: 0;
    max-height: none;
  }
}

.k-diff__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-1) var(--k-sp-2);
  background: var(--k-surface);
  box-shadow: inset 0 -1px 0 0 var(--k-line);
}
.k-diff__path {
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  min-width: 0; // a flex item defaults to its content width — without this a long path
  overflow: hidden; // pushes the collapse control out of the header instead of eliding
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-diff__spacer { flex: 1; }
.k-diff__note {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.k-diff__msg {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-diff__msg--error { color: var(--k-diff-del); }

.k-diff__body {
  max-height: 60vh;
  overflow: auto;
}

.k-diff__icon { --k-icon-size: var(--k-icon-md); }
.k-diff__sep {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--k-line-strong);
}
.k-diff__pad { padding: var(--k-sp-3); }

// With a preview on screen the block takes a fixed height: a rendered page or a PDF has no
// natural height of its own to grow to.
.k-diff__panes--split,
.k-diff__panes--preview {
  height: 60vh;
}
.k-diff__source {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.k-diff__panes--split .k-diff__body {
  flex: 1;
  min-height: 0;
  max-height: none;
}
</style>
