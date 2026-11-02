// apps/ui/src/composables/useFileMention.ts
import { nextTick, ref } from 'vue';
import { insertFileMention, opensMention } from '../lib/file-mention';

// The textarea side of a file mention, shared by the chat composer and both task forms. The
// host owns the text (`value`/`set`); this owns where the token lands and where the caret goes
// once the picker hands focus back.
//
// Two ways in, as with Хелпери: the host's «@» button (`toggle`), which inserts at the caret,
// and typing `@` at a word start (`onKeydown`). The typed `@` is written into the text HERE and
// its keystroke prevented, rather than left to the browser: the picker takes focus at once, and
// a character whose keydown moved focus can land in the newly focused filter instead. Closing
// the picker without a pick therefore leaves a plain `@`, the way the operator typed it.
export function useFileMention(opts: {
  el: () => HTMLTextAreaElement | HTMLInputElement | null | undefined;
  value: () => string;
  set: (value: string) => void;
  enabled: () => boolean;
}) {
  const open = ref(false);
  // Where the token goes, and whether a typed `@` sits there for it to replace.
  let at = 0;
  let typed = false;
  // Where the caret returns once the picker closes; set by a pick, defaulted by the close.
  let caret: number | null = null;

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== '@' || e.isComposing || open.value || !opts.enabled()) return;
    const el = opts.el();
    if (!el) return;
    const v = opts.value();
    const start = el.selectionStart ?? v.length;
    const end = el.selectionEnd ?? start;
    if (!opensMention(v, start)) return;
    e.preventDefault();
    opts.set(`${v.slice(0, start)}@${v.slice(end)}`);
    at = start;
    typed = true;
    caret = null;
    open.value = true;
  }

  // The button: a textarea keeps its selection through the blur the click causes, and one that
  // was never focused has its caret at the end of the text Vue set — either way the right spot.
  function toggle(): void {
    if (open.value) {
      open.value = false;
      return;
    }
    if (!opts.enabled()) return;
    const el = opts.el();
    at = el?.selectionEnd ?? opts.value().length;
    typed = false;
    caret = null;
    open.value = true;
  }

  function select(path: string): void {
    const next = insertFileMention(opts.value(), at, path, typed);
    opts.set(next.value);
    typed = false;
    caret = next.caret;
  }

  function close(): void {
    open.value = false;
    const target = caret ?? (typed ? at + 1 : at);
    typed = false;
    caret = null;
    // After the host re-renders the new text: setting the caret before that would be undone
    // by Vue writing `value`, which moves it to the end.
    void nextTick(() => {
      const el = opts.el();
      if (!el) return;
      el.focus();
      el.setSelectionRange(target, target);
    });
  }

  return { open, onKeydown, toggle, select, close };
}
