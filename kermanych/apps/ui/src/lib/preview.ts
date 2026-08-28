// apps/ui/src/lib/preview.ts
// True when this bundle is being served by a Kermanych PREVIEW — the throwaway pair of
// processes PreviewService starts for one session so a branch can be looked at. It sets
// VITE_KERMANYCH_PREVIEW on the web dev server, and only when it also started the preview
// api next to it (apps/api/src/preview/preview.service.ts).
//
// That api admits every request as a demo user, so the preview signs itself in: it renders
// the Агенти view instead of a login screen nobody could get past anyway (the GitHub OAuth
// redirect points at the real app, never at this run's random port). It also has no cloud —
// a temp DB seeded with inert rows, bound to no Supabase project — so the cloud reads that
// normally run on open are skipped rather than left to fail against the team's backend.
//
// A normal build never sees the variable: false in dev, in the desktop app, in production.
export const IS_PREVIEW = import.meta.env.VITE_KERMANYCH_PREVIEW === '1';

// The id the preview api stamps on every request it admits (apps/api/src/auth/auth.guard.ts).
// A placeholder, not a Supabase user: there is no profile, no token and no cloud behind it.
export const PREVIEW_USER_ID = 'preview';
