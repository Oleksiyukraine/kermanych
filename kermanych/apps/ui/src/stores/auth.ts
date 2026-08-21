// apps/ui/src/stores/auth.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Session as SupabaseSession, SupabaseClient } from '@supabase/supabase-js';
import { cloudEnv, createCloudClient, type Profile } from '@kermanych/cloud';
import { api, setAuthToken, setUnauthorizedHandler } from '../lib/api';

// One Supabase client per renderer, built when this module is first imported —
// which boot/supabase.ts triggers before the first navigation. PKCE, session
// persisted in localStorage, detectSessionInUrl on, so the SDK owns sign-in and
// token refresh. The anon key is public; RLS is the authorization surface.
const client: SupabaseClient = createCloudClient(
  cloudEnv('ui', import.meta.env as unknown as Record<string, string | undefined>),
);

// Must match OAUTH_REDIRECT in src-electron/oauth-loopback.ts and the entry in
// supabase/config.toml additional_redirect_urls. A fixed port, because Supabase
// matches redirect URLs exactly.
const LOOPBACK_REDIRECT = 'http://127.0.0.1:53170/callback';

export const useAuth = defineStore('auth', () => {
  const user = ref<{ id: string } | null>(null);
  const profile = ref<Profile | null>(null);
  const accessToken = ref<string | null>(null);

  let resolveReady: () => void = () => undefined;
  // Resolves once the initial session (if any) has been read and handed to the
  // local api. The router guard awaits it so there is no flash of /login.
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let initialized = false;

  // Mirror the Supabase session into this store AND into the local api. Called
  // on init and on every onAuthStateChange event (SIGNED_IN, TOKEN_REFRESHED,
  // SIGNED_OUT, USER_UPDATED).
  async function apply(session: SupabaseSession | null): Promise<void> {
    if (session) {
      const meta = (session.user.user_metadata ?? {}) as {
        user_name?: string;
        full_name?: string;
        avatar_url?: string;
      };
      user.value = { id: session.user.id };
      profile.value = {
        id: session.user.id,
        // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not the
        // same as an absent key, so only spread in what GitHub actually sent.
        ...(meta.user_name ? { githubUsername: meta.user_name } : {}),
        ...(meta.full_name ? { displayName: meta.full_name } : {}),
        ...(meta.avatar_url ? { avatarUrl: meta.avatar_url } : {}),
      };
      accessToken.value = session.access_token;
      setAuthToken(session.access_token);
      try {
        await api.authSession(session.access_token);
      } catch {
        // The local api may still be booting (Electron starts it in-process).
        // The next auth event — or the guard's own re-validation — recovers.
      }
      return;
    }

    const had = accessToken.value;
    user.value = null;
    profile.value = null;
    accessToken.value = null;
    // Send the sign-out WHILE the token is still installed: DELETE
    // /api/auth/session is guarded. Skip it entirely if we never had one, so a
    // 401 cannot bounce back into signOut() and loop.
    if (had) {
      try {
        await api.clearAuthSession();
      } catch {
        // Already signed out locally, or the api is down. Nothing to undo.
      }
    }
    setAuthToken(undefined);
  }

  async function init(): Promise<void> {
    if (initialized) return ready;
    initialized = true;
    // A 401 from any local call means our token is no longer the one the api
    // trusts. Surfacing it as a sign-out is the honest response; the guard on
    // `user` keeps it from recursing.
    setUnauthorizedHandler(() => {
      if (user.value) void signOut();
    });
    const { data } = await client.auth.getSession();
    await apply(data.session);
    client.auth.onAuthStateChange((_event, session) => {
      void apply(session);
    });
    resolveReady();
    return ready;
  }

  async function signInWithGithub(): Promise<void> {
    const startOAuth = window.kermanych?.startOAuth;
    if (startOAuth) {
      // Desktop: build the authorize URL here (the PKCE verifier must stay in
      // this renderer's storage), let main open the system browser and catch the
      // loopback redirect, then finish the exchange here.
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: LOOPBACK_REDIRECT, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data.url) throw new Error('Supabase не повернув URL авторизації');
      const { code } = await startOAuth(data.url);
      // Pass the flowId back: v2 stores the PKCE verifier per flow at
      // `${storageKey}-flow-${flowId}-code-verifier`, and the fixed legacy key
      // only mirrors the most recent flow. Same client instance, same storage —
      // that is why the exchange happens here and not in the main process.
      const exchanged = await client.auth.exchangeCodeForSession(
        code,
        data.flowId ? { flowId: data.flowId } : undefined,
      );
      if (exchanged.error) throw exchanged.error;
      return;
    }
    // Browser: a plain redirect. detectSessionInUrl finishes the exchange when
    // the tab comes back (the code arrives as ?code=… ahead of the hash route).
    const { error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/#/auth/callback` },
    });
    if (error) throw error;
  }

  async function signOut(): Promise<void> {
    await client.auth.signOut();
    await apply(null);
  }

  return { client, user, profile, accessToken, ready, init, signInWithGithub, signOut };
});
