<template>
  <div class="k-doc-preview" :aria-label="t('kit.docPreview.label', { path })">
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
      @click="onMarkdownClick"
      v-html="markdownHtml"
    ></div>
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
// sandbox, PDF in Chromium's own viewer. The caller hands over a `load` for the raw bytes of
// any repo-relative path — the same reader for the file itself and for a Markdown file's
// relative images — so this component never learns whether it sits on a session or a project.
//
// `text` skips the fetch when the caller already holds the body (KFileView). `refreshKey`
// re-reads while an agent keeps editing; an unchanged body is left alone, so a refresh never
// resets the scroll of a page that did not change.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { docPreviewKind } from '../../lib/doc-preview';
import { renderDoc } from '../../lib/markdown';
import KSkeleton from './KSkeleton.vue';

const props = defineProps<{
  path: string;
  load: (path: string) => Promise<Blob>;
  text?: string | null;
  refreshKey?: unknown;
}>();

const { t } = useI18n();

const kind = computed(() => docPreviewKind(props.path));

const loadedFor = ref<string | null>(null);
const error = ref<string | null>(null);
const markdownHtml = ref('');
const srcdoc = ref('');
const pdfUrl = ref<string | null>(null);
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

// In-repo links render as href="#" (the docs page navigates its tree with them); here there
// is no tree to move, so the click must not scroll the pane to the top.
function onMarkdownClick(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest('a[data-doc-path]')) e.preventDefault();
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
