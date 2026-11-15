import { defineBoot } from '#q-app/wrappers';
import { createApp, h, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import AuthLoader from 'components/auth/AuthLoader.vue';
import { uk } from '../i18n/uk';
import { en } from '../i18n/en';
import type { MessageSchema } from '../i18n/schema';
import { i18n } from './i18n';
import { signInLoaderHold } from '../lib/sign-in-loader';

// The start-up splash is the sign-in loader (components/auth/AuthLoader.vue): the pixel word and
// a quote, over the boot files that follow (the local api starting, the session being read).
// index.html paints only the empty canvas of #k-splash before the bundle loads; this boot mounts
// the loader into it, and App.vue calls `closeSplash()` once the app has mounted.
//
// A separate Vue app, so it shows before Quasar mounts the main one. It gets its own vue-i18n
// instance: vue-i18n disposes the instance it was installed with when that app unmounts, and the
// shared `i18n` must outlive the splash.

let splash: App | null = null;
let stopStatus: (() => void) | undefined;

export default defineBoot(() => {
  const el = document.getElementById('k-splash');
  if (!el) return;
  const own = createI18n<[MessageSchema], 'uk' | 'en', false>({
    legacy: false,
    locale: i18n.global.locale.value,
    fallbackLocale: 'uk',
    messages: { uk, en },
  });
  // Desktop: main reports the local api starting, then listening (the latest replayed at once).
  // The web build has no local service and goes straight to signing in.
  const step = ref<'backend' | 'auth'>(window.kermanych?.onBootStatus ? 'backend' : 'auth');
  stopStatus = window.kermanych?.onBootStatus?.((status) => {
    step.value = status === 'ready' ? 'auth' : 'backend';
  });
  splash = createApp({
    render: () =>
      h(AuthLoader, {
        status: own.global.t(step.value === 'backend' ? 'common.login.startingBackend' : 'common.login.signingIn'),
      }),
  }).use(own);
  splash.mount(el);
});

/**
 * Fades the splash out once the loader has been on screen its minimum time, then unmounts and
 * removes it. A fixed overlay outside #q-app, so its removal moves nothing in the layout.
 */
export async function closeSplash(): Promise<void> {
  const el = document.getElementById('k-splash');
  if (!el) return;
  await signInLoaderHold();
  const remove = (): void => {
    stopStatus?.();
    splash?.unmount();
    splash = null;
    el.remove();
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    remove();
    return;
  }
  el.addEventListener('transitionend', remove, { once: true });
  el.classList.add('k-splash--out');
}
