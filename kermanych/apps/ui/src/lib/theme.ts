import { nextTick, ref, watch, type Ref } from 'vue';
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

// Reveal duration. Long enough to read as a wipe across a full window, short
// enough that the frozen snapshot below is not felt as lag.
const REVEAL_MS = 480;

/**
 * Flip the theme, revealing the new palette under a circle that grows from
 * `origin` — the control that was activated — to the furthest viewport corner.
 *
 * The View Transitions API holds the page as two stacked snapshots for the
 * duration, so nothing is interactive while the reveal runs. That is the whole
 * cost of the effect, and the reason it is worth it only for a full repaint.
 */
export function toggleTheme(origin?: DOMRect | null): void {
  const next: KTheme = theme.value === 'light' ? 'dark' : 'light';

  // Instant paths: an engine without the API, and an operator who asked for
  // less motion — a full-screen wipe is precisely what that preference covers.
  if (
    typeof document === 'undefined' ||
    !document.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    theme.value = next;
    return;
  }

  const transition = document.startViewTransition(async () => {
    theme.value = next;
    // `initTheme`'s watcher is pre-flush, so without awaiting the flush the
    // browser captures the "new" snapshot before `data-theme` reaches <html>,
    // and the reveal wipes in the OLD palette.
    await nextTick();
  });

  void transition.ready
    .then(() => {
      const { innerWidth: w, innerHeight: h } = window;
      const x = origin ? origin.left + origin.width / 2 : w / 2;
      const y = origin ? origin.top + origin.height / 2 : h / 2;
      // Reach for the furthest corner: any smaller radius stops short of the
      // opposite edge and leaves a crescent of the old palette behind.
      const radius = Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: REVEAL_MS,
          easing: 'ease-in-out',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {
      // Skipped transition — a second toggle mid-flight, or a hidden tab. The
      // theme itself already changed; only the animation is lost.
    });
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
