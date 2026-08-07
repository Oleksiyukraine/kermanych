import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('pages/IndexPage.vue') }],
  },
  {
    path: '/kit',
    component: () => import('layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('pages/KitGalleryPage.vue') }],
  },

  // Always leave this as the last one.
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
