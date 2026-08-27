import { watch } from 'vue';
import { defineRouter } from '#q-app/wrappers';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import routes from './routes';
import { useAuth } from '../stores/auth';

export default defineRouter(({ store }) => {
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : process.env.VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave as is and change quasar.config.ts -> build -> vueRouterMode instead.
    history: createHistory(process.env.VUE_ROUTER_BASE),
  });

  // Auth gate. `ready` resolves once boot/supabase.ts has read the persisted
  // session, so a signed-in user never sees /login flash by. The pinia instance
  // comes from defineRouter's context because guards run outside a component.
  let watching = false;
  Router.beforeEach(async (to) => {
    const auth = useAuth(store);
    await auth.ready;

    // The session changing must move the app on its own — neither sign-in nor
    // sign-out navigates, so beforeEach would never run. Installed on the first
    // navigation so the store is guaranteed to exist.
    if (!watching) {
      watching = true;
      watch(
        () => auth.user,
        (u) => {
          const at = Router.currentRoute.value.name;
          if (u) {
            // Gained a session: leave the signed-out screens. This is what ends
            // the OAuth round trip in BOTH builds — the browser tab that came
            // back to /auth/callback, and Electron sitting on /login while
            // exchangeCodeForSession resolved in place.
            if (at === 'login' || at === 'auth-callback') {
              void Router.replace({ name: 'agents' });
            }
            return;
          }
          // Lost it — on sign-out, or when a 401 from the local api forces one.
          if (at !== 'login') void Router.replace({ name: 'login' });
        },
      );
    }

    const isPublic = to.matched.some((r) => r.meta.public === true);
    if (!auth.user && !isPublic) return { name: 'login' };
    // Already signed in: the signed-out screens have nothing to show. Covers a
    // persisted session landing straight on /auth/callback, where no `user`
    // transition happens for the watcher to see.
    if (auth.user && (to.name === 'login' || to.name === 'auth-callback')) {
      return { name: 'agents' };
    }
    return true;
  });

  return Router;
});
