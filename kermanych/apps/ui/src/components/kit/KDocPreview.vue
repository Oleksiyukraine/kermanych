<template>
  <div
    class="k-doc-preview k-scroller"
    tabindex="0"
    :aria-label="t('kit.docPreview.label', { path })"
    @click="onClick"
    v-on="panZoom.listeners"
  >
    <div v-if="phase === 'skeleton'" class="k-doc-preview__pad">
      <KSkeleton variant="lines" :rows="6" />
    </div>
    <template v-else-if="phase === 'blank'"></template>
    <p v-else-if="error" class="k-doc-preview__msg mono" role="alert">{{ error }}</p>
    <!-- renderDoc keeps html:false, so v-html output is a controlled tag set. -->
    <div
      v-else-if="kind === 'markdown'"
      ref="markdownEl"
      class="k-doc-preview__pad k-doc-preview__markdown k-log__markdown"
      v-html="markdownHtml"
    ></div>
    <!-- An <img> never runs an SVG's scripts or loads its external resources, so a
         repository SVG is drawn without being trusted. -->
    <!-- Pinch or ⌘-scroll to zoom, swipe or drag to move, double-click to fit (usePanZoom). -->
    <div
      v-else-if="(kind === 'svg' || kind === 'image') && pictureUrl"
      ref="stageEl"
      class="k-doc-preview__stage"
      data-pz-stage="free"
    >
      <img class="k-doc-preview__picture" :src="pictureUrl" :alt="path" draggable="false">
    </div>
    <!-- An empty sandbox: no scripts, no forms, no top navigation, and an opaque origin, so
         the page cannot reach the app or its api key. -->
    <iframe
      v-else-if="kind === 'html'"
      class="k-doc-preview__frame k-doc-preview__frame--page"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="t('kit.docPreview.label', { path })"
      :srcdoc="srcdoc"
    ></iframe>
    <!-- Not sandboxed: a sandbox attribute disables Chromium's PDF viewer. The blob is typed
         application/pdf here, so nothing else can render from it. -->
    <iframe
      v-else-if="kind === 'pdf' && pdfUrl"
      class="k-doc-preview__frame"
      :title="t('kit.docPreview.label', { path })"
      :src="pdfUrl"
    ></iframe>
  </div>
</template>

<script setup lang="ts">
// The rendered side of a file viewer: Markdown through the docs renderer, HTML in an empty
// sandbox, PDF in Chromium's own viewer, a picture as an <img>. A picture, and each diagram inside a doc,
// pinches and moves (usePanZoom). The caller hands over a `load` for the raw bytes of
// any repo-relative path — the same reader for the file itself and for a Markdown file's
// relative images — so this component never learns whether it sits on a session or a project.
//
// `text` skips the fetch when the caller already holds the body (KFileView). `refreshKey`
// re-reads while an agent keeps editing; an unchanged body is left alone, so a refresh never
// resets the scroll of a page that did not change. A click on an in-repo link of a Markdown
// doc is handed to the caller as `open`, with the repo-relative path it points at.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { usePanZoom } from '../../composables/usePanZoom';
import { docPreviewKind } from '../../lib/doc-preview';
import { renderDoc } from '../../lib/markdown';
import KSkeleton from './KSkeleton.vue';

const props = defineProps<{
  path: string;
  load: (path: string) => Promise<Blob>;
  text?: string | null;
  refreshKey?: unknown;
}>();
const emit = defineEmits<{ open: [path: string] }>();

const { t } = useI18n();

const kind = computed(() => docPreviewKind(props.path));

const loadedFor = ref<string | null>(null);
const error = ref<string | null>(null);
const markdownHtml = ref('');
const srcdoc = ref('');
const pdfUrl = ref<string | null>(null);
const pictureUrl = ref<string | null>(null);
const stageEl = ref<HTMLElement | null>(null);
const panZoom = usePanZoom();
const markdownEl = ref<HTMLElement | null>(null);
const phase = useLoadPhase(() => loadedFor.value !== props.path);

// What is on screen now, to skip a refresh that brought the same body.
let shownText: string | null = null;
let shownBytes: Uint8Array | null = null;
// Object URLs of the Markdown file's images, by path; dropped with the document.
const imageUrls = new Map<string, string>();
let run = 0;

function dropDocument(): void {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = null;
  if (pictureUrl.value) URL.revokeObjectURL(pictureUrl.value);
  pictureUrl.value = null;
  panZoom.reset(stageEl.value);
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
  markdownHtml.value = '';
  srcdoc.value = '';
  shownText = null;
  shownBytes = null;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

async function refresh(): Promise<void> {
  const id = ++run;
  const path = props.path;
  const k = kind.value;
  if (!k) return;
  try {
    if (k === 'pdf') {
      const bytes = new Uint8Array(await (await props.load(path)).arrayBuffer());
      if (id !== run || sameBytes(shownBytes, bytes)) return;
      dropDocument();
      shownBytes = bytes;
      pdfUrl.value = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    } else if (k === 'svg' || k === 'image') {
      // An SVG's body may already be at hand; typed explicitly, since an <img> draws an SVG
      // only from an image/svg+xml blob.
      const blob = k === 'svg' && props.text != null
        ? new Blob([props.text], { type: 'image/svg+xml' })
        : await props.load(path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (id !== run || sameBytes(shownBytes, bytes)) return;
      dropDocument();
      shownBytes = bytes;
      pictureUrl.value = URL.createObjectURL(k === 'svg' ? new Blob([bytes], { type: 'image/svg+xml' }) : blob);
    } else {
      const text = props.text ?? (await (await props.load(path)).text());
      if (id !== run || text === shownText) return;
      shownText = text;
      if (k === 'html') srcdoc.value = text;
      else {
        markdownHtml.value = renderDoc(text, { folder: '', dir: dirOf(path) });
        void resolveImages(id);
      }
    }
    error.value = null;
  } catch (e) {
    // The raw route answers 404 for a file over its 4 MB cap as well as a missing one.
    const msg = e instanceof Error ? e.message : String(e);
    if (id === run) error.value = /not found/i.test(msg) ? t('kit.docPreview.unavailable') : msg;
  } finally {
    if (id === run) loadedFor.value = path;
  }
}

// renderDoc leaves a relative image as data-doc-path with no src; fetch each through `load`.
async function resolveImages(id: number): Promise<void> {
  await nextTick();
  wrapDiagrams();
  const imgs = markdownEl.value?.querySelectorAll<HTMLImageElement>('img[data-doc-path]') ?? [];
  for (const img of imgs) {
    const rel = img.dataset.docPath;
    if (!rel) continue;
    let url = imageUrls.get(rel);
    if (!url) {
      try {
        const blob = await props.load(rel);
        if (id !== run) return;
        url = URL.createObjectURL(blob);
        imageUrls.set(rel, url);
      } catch {
        continue; // a missing image stays a broken one; the text is what matters
      }
    }
    img.src = url;
  }
}

// Each picture of the doc gets its own clipped box to pinch and move in (usePanZoom's
// `inline` stage). One inside a link is a badge or a pointer: it stays a plain image.
function wrapDiagrams(): void {
  for (const img of markdownEl.value?.querySelectorAll<HTMLImageElement>('img') ?? []) {
    if (img.closest('a, [data-pz-stage]')) continue;
    const box = document.createElement('span');
    box.className = 'k-doc-preview__diagram';
    box.dataset.pzStage = 'inline';
    img.draggable = false;
    img.replaceWith(box);
    box.append(img);
  }
}

// Delegated — v-html content has no template to bind to. An in-repo link renders as href="#":
// the click must not scroll the pane to the top, and goes to the caller instead.
function onClick(e: MouseEvent): void {
  const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-doc-path]');
  if (!link) return;
  e.preventDefault();
  if (link.dataset.docPath) emit('open', link.dataset.docPath);
}

watch(
  () => props.path,
  () => {
    run++;
    dropDocument();
    error.value = null;
    loadedFor.value = null;
  },
);
watch([() => props.path, () => props.refreshKey, () => props.text], () => void refresh(), { immediate: true });

onBeforeUnmount(() => {
  run++;
  dropDocument();
});
</script>

<style scoped lang="scss">
.k-doc-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  height: 100%;
  overflow: auto;
  background: var(--k-bg);
}
.k-doc-preview__pad {
  padding: var(--k-sp-3);
}
.k-doc-preview__markdown :deep(img) {
  max-width: 100%;
}
// The picture's own pane: it moves inside, nothing scrolls. touch-action none hands every
// finger to the pointer handlers rather than to the page's own pan and zoom.
.k-doc-preview__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
}
// A diagram inside a doc: clipped to its own fitted size. One finger still scrolls the doc;
// the pinch is the diagram's. It takes a grab cursor only once zoomed in.
.k-doc-preview__markdown :deep(.k-doc-preview__diagram) {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  vertical-align: top;
  line-height: 0;
  touch-action: pan-x pan-y;
  img { display: block; transform-origin: 0 0; user-select: none; }
  &[data-panzoom='zoomed'] { cursor: grab; }
}
.k-doc-preview :deep([data-panzoom='dragging']) { cursor: grabbing; }
// Laid out at the stage's width (fit), then moved and scaled from its top-left corner.
.k-doc-preview__picture {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  width: 100%;
  height: auto;
  transform-origin: 0 0;
  user-select: none;
}
.k-doc-preview__msg {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
.k-doc-preview__frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  display: block;
}
// A page with no background of its own is drawn on white, as a browser would.
.k-doc-preview__frame--page {
  background: #fff;
}
</style>
