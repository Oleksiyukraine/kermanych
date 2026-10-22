import { defineBoot } from '#q-app/wrappers';

// The first boot file. On the desktop build main creates the window while the local api is
// still starting (docs/specs/2026-10-21-async-feedback.md, decision 10), so nothing may talk to
// the api before it listens — the `supabase` boot hands the session token to it. The web build
// has no local service and no bridge: this is a no-op there.
export default defineBoot(async () => {
  // Rejects when the api failed to start; main then shows the error and quits.
  await window.kermanych?.backendReady?.();
  // The splash in index.html moves on to the sign-in step the `supabase` boot performs next.
  const splash = document.getElementById('k-splash');
  if (splash) splash.dataset.status = 'auth';
});
