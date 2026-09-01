import type { RouteRecordRaw } from 'vue-router';
import { MANAGEMENT_DEFAULT_SECTION, MANAGEMENT_SECTIONS } from '@kermanych/core';

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a Supabase session. Everything else is redirected to
    // /login by the beforeEach guard in router/index.ts.
    public?: boolean;
  }
}

// Which Менеджмент sections have a screen of their own. Labels, paths and what the
// Менеджмент assistant may do with each live in @kermanych/core (management.ts); the
// component belongs here, where the rest of the route records keep theirs, so promoting a
// section is one entry in this map.
const SECTION_PAGES: Record<string, RouteRecordRaw['component']> = {
  'management-integrations': () => import('pages/ManagementIntegrationsPage.vue'),
  'management-releases': () => import('pages/ManagementReleasesPage.vue'),
  'management-risks': () => import('pages/ManagementRisksPage.vue'),
};

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
  // waits: the `auth.user` watcher in router/index.ts moves on to the Агенти view
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
      { path: '', name: 'agents', component: () => import('pages/AgentsPage.vue'), meta: { public: false } },
      { path: 'board', name: 'board', component: () => import('pages/BoardPage.vue'), meta: { public: false } },
      { path: 'kit', name: 'kit', component: () => import('pages/KitGalleryPage.vue'), meta: { public: false } },
      { path: 'chat', name: 'chat', component: () => import('pages/ChatPage.vue'), meta: { public: false } },
      // Налаштування is ONE record with the category in a param, not a nested
      // shell like Менеджмент below: all eleven categories share a single
      // component, because the save bar and the draft they queue into are one
      // piece of state. `:section?` keeps a bare /settings resolvable, and
      // `settingsSection()` (lib/settings.ts) maps an unknown or missing segment
      // onto the default rather than rendering an empty pane.
      {
        path: 'settings/:section?',
        name: 'settings',
        component: () => import('pages/SettingsPage.vue'),
        meta: { public: false },
      },
      // Менеджмент is a nested shell: ManagementPage owns the section strip and
      // the «pick a project» gate, one child route per section. The named parent
      // is what the top nav matches on (route.matched in MainLayout), and the
      // empty path redirects rather than rendering, so /management has exactly
      // one resolution instead of two records competing for it.
      {
        path: 'management',
        name: 'management',
        component: () => import('pages/ManagementPage.vue'),
        meta: { public: false },
        children: [
          { path: '', redirect: { name: MANAGEMENT_DEFAULT_SECTION } },
          // Sections keep the shared placeholder until they earn a screen; the ones
          // that have earned it are listed in SECTION_PAGES above.
          ...MANAGEMENT_SECTIONS.map((s) => ({
            path: s.path,
            name: s.name,
            component:
              SECTION_PAGES[s.name] ?? (() => import('pages/ManagementSectionPage.vue')),
            meta: { public: false },
          })),
        ],
      },
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
