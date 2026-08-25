import { ref, watch, type Ref } from 'vue';
import type { KTheme } from '@kermanych/tokens';

// The app's colour theme. `@kermanych/tokens` ships both sets in one sheet; the
// only runtime state is which one is selected, expressed as `data-theme` on
// <html> (see `:root[data-theme='light']` in tokens.css).
//
// Why an attribute on the root element rather than a class or a swapped
// stylesheet: the dark set lives in plain `:root`, so a document that has never
// been touched already renders correctly and a reload cannot flash the wrong
// palette for a dark-theme user. A light-theme user gets the attribute written
// from `boot/tokens.ts`, before the app mounts.
//
// Why a device-local preference and not the Supabase profile: the theme belongs
// to the screen in front of you, not to the account — the same operator on a
// bright laptop and a dim desktop wants different answers.

/** localStorage key. Namespaced like the shell's other UI preferences. */
export const STORAGE_KEY = 'kermanych.theme';

/** Dark is the product's identity, so it wins over the OS preference. */
export const DEFAULT_THEME: KTheme = 'dark';

// Storage access is fallible on purpose: private-browsing windows and embedded
// webviews throw on `localStorage` rather than returning null, and a theme that
// cannot be remembered must still be switchable for the current session. Both
// helpers take the store as an argument so the failure modes are testable
// without a DOM.

/** Stored theme, or the default for missing, unknown or unreadable values. */
export function readTheme(store: Pick<Storage, 'getItem'> | null | undefined): KTheme {
  let raw: string | null = null;
  try {
    raw = store?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return DEFAULT_THEME;
  }
  return raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME;
}

export function writeTheme(store: Pick<Storage, 'setItem'> | null | undefined, value: KTheme): void {
  try {
    store?.setItem(STORAGE_KEY, value);
  } catch {
    /* storage unavailable — the switch still holds for this session */
  }
}

/** Current theme. Assigning to it applies and persists (see `initTheme`). */
export const theme: Ref<KTheme> = ref(
  readTheme(typeof localStorage === 'undefined' ? null : localStorage),
);

export function applyTheme(value: KTheme): void {
  if (typeof document === 'undefined') return;
  // Written for both themes, not just light: DevTools and any future
  // `[data-theme='dark']` rule can then read the state off the element.
  document.documentElement.dataset.theme = value;
}

export function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light';
}

// Boot may re-run under HMR; a second watcher would double every write.
let started = false;

/** Paint the stored theme and keep <html> + localStorage in step with it. */
export function initTheme(): void {
  applyTheme(theme.value);
  if (started) return;
  started = true;
  watch(theme, (value) => {
    applyTheme(value);
    writeTheme(typeof localStorage === 'undefined' ? null : localStorage, value);
  });
}
