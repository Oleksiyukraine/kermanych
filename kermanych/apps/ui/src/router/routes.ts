import type { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a Supabase session. Everything else is redirected to
    // /login by the beforeEach guard in router/index.ts.
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('layouts/AuthLayout.vue'),
    meta: { public: true },
  },

  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', name: 'workspace', component: () => import('pages/WorkspacePage.vue'), meta: { public: false } },
      // Plan C (cloud board) adds the /board child here.
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
