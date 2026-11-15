// The sign-in loader (components/auth/AuthLoader.vue) stays on screen at least
// SIGN_IN_LOADER_MIN_MS, so a fast sign-in does not blink the pixel word and the quote away
// before they can be seen. The loader marks when it appeared; the router waits out the rest
// before it leaves /login or /auth/callback (router/index.ts).

export const SIGN_IN_LOADER_MIN_MS = 3000;

let shownAt: number | null = null;

/** The loader appeared (`at`) or left the screen (`null`). */
export function markSignInLoader(at: number | null): void {
  shownAt = at;
}

/** Resolves once the loader on screen has been shown its minimum time; at once when none is. */
export function signInLoaderHold(): Promise<void> {
  const left = shownAt === null ? 0 : SIGN_IN_LOADER_MIN_MS - (performance.now() - shownAt);
  const { promise, resolve } = Promise.withResolvers<void>();
  if (left > 0) setTimeout(resolve, left);
  else resolve();
  return promise;
}
