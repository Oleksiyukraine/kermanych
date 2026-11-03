// Find-in-file for a file viewer (KFileView, KDiffView). Two things can be searched: the source
// shown through KCodeView, and a Markdown preview rendered by KDocPreview.
//
// The viewer hands over the source text it shows — null while there is none on screen (a
// diff, a rendered-only preview, a binary) — whether a searchable preview is on screen, and
// its root element. It gets back the find bar's state for KFindBar, the hits for KCodeView,
// the query for KDocPreview, and a keydown handler for its root.
//
// With the source on screen the source leads: its matches make the count and the stepping,
// and a preview beside it (split) only marks its own. With the preview alone, KDocPreview
// reports how many it found (`setRenderedTotal`) and steps through those.
//
// ⌘F / Ctrl+F opens the bar (or refocuses it), Enter / Shift+Enter step, Esc closes it and
// gives focus back to the code. ⌘F is the viewer's own while focus is inside it — stopped
// there, so the session browser's window-wide ⌘F does not open its find bar as well.
import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FIND_MAX_HITS, findHits } from '../lib/find-in-text';

/** What KDocPreview searches for; `current` only when the preview is the one stepped through. */
export type PreviewFind = { query: string; matchCase: boolean; wholeWord: boolean; current: number | undefined };

export function useFindInText(
  source: () => string | null,
  rootEl: Ref<HTMLElement | null>,
  rendered: () => boolean = () => false,
) {
  const { t } = useI18n();
  const open = ref(false);
  const query = ref('');
  const matchCase = ref(false);
  const wholeWord = ref(false);
  const current = ref(0);
  const renderedTotal = ref(0);

  const onSource = computed(() => source() !== null);
  const available = computed(() => onSource.value || rendered());
  const shown = computed(() => open.value && available.value);
  const hits = computed(() => {
    const body = shown.value ? source() : null;
    if (body === null) return [];
    return findHits(body.split('\n'), query.value, { matchCase: matchCase.value, wholeWord: wholeWord.value });
  });
  const total = computed(() => (onSource.value ? hits.value.length : renderedTotal.value));
  // A new query, case or whole-word setting starts from the first match, as does a switch
  // between source and preview; a re-read of the file keeps the place while it still exists.
  watch([query, matchCase, wholeWord, onSource], () => { current.value = 0; });
  watch(total, (n) => { if (current.value >= n) current.value = 0; });
  // For KCodeView: no current match while the bar is closed, so nothing scrolls.
  const currentHit = computed(() => (shown.value && onSource.value ? current.value : undefined));
  const previewFind = computed<PreviewFind | null>(() => (shown.value && rendered()
    ? {
      query: query.value,
      matchCase: matchCase.value,
      wholeWord: wholeWord.value,
      current: onSource.value ? undefined : current.value,
    }
    : null));
  function setRenderedTotal(n: number): void {
    renderedTotal.value = n;
  }

  const count = computed(() => {
    const n = total.value;
    if (!query.value) return '';
    if (n === 0) return t('kit.fileView.find.none');
    return `${current.value + 1} / ${n}${n >= FIND_MAX_HITS ? '+' : ''}`;
  });

  function openFind(): void {
    open.value = true;
    void nextTick(() => {
      const input = rootEl.value?.querySelector<HTMLInputElement>('.k-find-bar__input');
      input?.focus();
      input?.select();
    });
  }
  function close(): void {
    open.value = false;
    rootEl.value?.querySelector<HTMLElement>('.k-scroller')?.focus({ preventScroll: true });
  }
  function toggle(): void {
    if (shown.value) close();
    else openFind();
  }
  function step(forward: boolean): void {
    const n = total.value;
    if (n === 0) return;
    current.value = (current.value + (forward ? 1 : n - 1)) % n;
  }
  // By key code, so a Ukrainian layout works too.
  function onKeydown(e: KeyboardEvent): void {
    if (e.code !== 'KeyF' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (!available.value) return;
    e.preventDefault();
    e.stopPropagation();
    openFind();
  }

  return {
    available, shown, query, matchCase, wholeWord, hits, total, currentHit, previewFind, count,
    setRenderedTotal, toggle, close, step, onKeydown,
  };
}
