// apps/ui/src/boot/supabase.ts
import { defineBoot } from '#q-app/wrappers';
import { useAuth } from '../stores/auth';

// Bring the Supabase session up BEFORE the first navigation: importing the auth
// store constructs the client, and init() reads any persisted session, hands the
// token to the local api, and subscribes to future auth changes. The router guard
// awaits `ready`, so there is no flash of /login for an already-signed-in user.
export default defineBoot(async ({ store }) => {
  await useAuth(store).init();
});
