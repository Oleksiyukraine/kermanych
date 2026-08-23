import type { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a Supabase session. Everything else is redirected to
    // /login by the beforeEach guard in router/index.ts.
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  // The signed-out shell. Two records rather than one, because /login and
  // /auth/callback share no path prefix; both mount AuthLayout so the sign-in
  // toast surface exists on either screen.
  {
    path: '/login',
    component: () => import('layouts/AuthLayout.vue'),
    meta: { public: true },
    children: [{ path: '', name: 'login', component: () => import('pages/LoginPage.vue') }],
  },

  // Where the browser OAuth redirect lands (redirectTo in stores/auth.ts) and
  // where the desktop flow is parked while exchangeCodeForSession runs. It only
  // waits: the `auth.user` watcher in router/index.ts moves on to the workspace
  // the moment the session exists.
  {
    path: '/auth/callback',
    component: () => import('layouts/AuthLayout.vue'),
    meta: { public: true },
    children: [
      { path: '', name: 'auth-callback', component: () => import('pages/AuthCallbackPage.vue') },
    ],
  },

  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', name: 'workspace', component: () => import('pages/WorkspacePage.vue'), meta: { public: false } },
      { path: 'board', name: 'board', component: () => import('pages/BoardPage.vue'), meta: { public: false } },
      { path: 'kit', name: 'kit', component: () => import('pages/KitGalleryPage.vue'), meta: { public: false } },
    ],
  },

  // Always leave this as the last one.
  {
    path: '/:catchAll(.*)*',
    name: 'not-found',
    component: () => import('pages/ErrorNotFound.vue'),
    meta: { public: true },
  },
];

export default routes;
