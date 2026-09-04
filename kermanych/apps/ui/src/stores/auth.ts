// apps/ui/src/stores/auth.ts
import { defineStore } from 'pinia';
import { markRaw, ref } from 'vue';
import type { Session as SupabaseSession, SupabaseClient } from '@supabase/supabase-js';
import { cloudEnv, createCloudClient, type Profile, getMyAgentRuntime, setMyAgentRuntime } from '@kermanych/cloud';
import type { AgentRuntimeKind } from '@kermanych/core';
import { api, setAuthToken, setUnauthorizedHandler } from '../lib/api';
import { IS_PREVIEW, PREVIEW_USER_ID } from '../lib/preview';
import { useOrchestrator } from './orchestrator';
import { globalTr } from '../boot/i18n';

// One Supabase client per renderer, built when this module is first imported —
// which boot/supabase.ts triggers before the first navigation. PKCE, session
// persisted in localStorage, detectSessionInUrl on, so the SDK owns sign-in and
// token refresh. The publishable/anon key is public; RLS is the authorization surface.
// NEVER remove the markRaw: the store exposes this client, and Pinia wraps a setup
// store's return in reactive(), whose deep unwrapping would strip the client's
// protected fields (no @kermanych/cloud helper would then accept `auth.client`) and
// put a Proxy around the realtime socket. Consumers — including Plan C's channels —
// must use it raw and must not re-wrap it.
const client = markRaw(
  createCloudClient(cloudEnv('ui', import.meta.env as unknown as Record<string, string | undefined>)),
);

// Must match OAUTH_REDIRECT in src-electron/oauth-loopback.ts and the entry in
// supabase/config.toml additional_redirect_urls. A fixed port, because Supabase
// matches redirect URLs exactly.
const LOOPBACK_REDIRECT = 'http://127.0.0.1:53170/callback';

export const useAuth = defineStore('auth', () => {
  const user = ref<{ id: string } | null>(null);
  const profile = ref<Profile | null>(null);
  const accessToken = ref<string | null>(null);
  const runtime = ref<AgentRuntimeKind | null>(null);

  let resolveReady: () => void = () => undefined;
  // Resolves once the initial session (if any) has been read and handed to the
  // local api. The router guard awaits it so there is no flash of /login.
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let initialized = false;
  // The token the local api has actually ACCEPTED. Deduping the handoff on this
  // rather than on `accessToken` keeps a signed-in boot to a single POST —
  // supabase-js re-emits INITIAL_SESSION with the same session right after
  // init()'s own getSession(), and tab-focus SIGNED_IN / USER_UPDATED repeat it
  // later — while still retrying a handoff that FAILED because the api was
  // still booting. That retry matters: the guard no longer adopts an unknown
  // bearer, so a dropped handoff would leave every later call 401.
  let handedOff: string | undefined;

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
      if (handedOff === session.access_token) return;
      try {
        await api.authSession(session.access_token);
        handedOff = session.access_token;
      } catch {
        // The local api may still be booting (Electron starts it in-process).
        // `handedOff` stays behind, so the next auth event retries.
      }
      // Best-effort runtime load: never block the UI for a stale cloud read.
      try {
        runtime.value = await getMyAgentRuntime(client);
      } catch {
        runtime.value = null;
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
    handedOff = undefined;
    setAuthToken(undefined);
  }

  async function init(): Promise<void> {
    if (initialized) return ready;
    initialized = true;
    // A preview never signs in: its api admits every request as this demo user, and no
    // OAuth redirect can come back to its random port (lib/preview.ts). Adopt that user
    // and stop — the Supabase client is left untouched (no session to read, no token to
    // hand over), and deliberately no 401 handler is installed: a preview must never
    // bounce itself to a login screen. `profile` stays null, which is the truth here.
    if (IS_PREVIEW) {
      user.value = { id: PREVIEW_USER_ID };
      resolveReady();
      return ready;
    }
    // Resolved here, not inside the handler, so the toast surface exists before
    // the first 401 can land. The orchestrator store holds only refs until
    // connect() is called, which AuthLayout never does.
    const ui = useOrchestrator();
    // A 401 from any local call means our token is no longer the one the api
    // trusts. Surfacing it as a sign-out is the honest response; the guard on
    // `user` keeps it from recursing — a 401 on the sign-out DELETE itself
    // cannot bounce back in.
    setUnauthorizedHandler(() => {
      if (!user.value) return;
      ui.notify(globalTr.t('common.notify.sessionExpired'), 'error');
      void signOut();
    });
    try {
      const { data } = await client.auth.getSession();
      await apply(data.session);
      client.auth.onAuthStateChange((_event, session) => {
        void apply(session);
      });
    } catch (e) {
      // boot/supabase.ts awaits init(); rethrowing would take the whole app
      // down over a storage hiccup. A signed-out app that still renders /login
      // is strictly better than a dead boot.
      console.error('[auth] init failed, continuing signed out', e);
    } finally {
      // ALWAYS settle. getSession() can reject (NavigatorLock acquire timeout,
      // blocked storage), and router/index.ts awaits `ready` in every
      // beforeEach — an unsettled promise is a permanently blank screen that a
      // reload cannot fix. Failing leaves `user` null, so the guard sends the
      // user to /login, which is the honest fallback.
      resolveReady();
    }
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
      if (!data.url) throw new Error(globalTr.t('errors.oauth_no_url'));
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

  async function chooseRuntime(kind: AgentRuntimeKind): Promise<void> {
    await setMyAgentRuntime(client, kind);   // cloud = source of truth
    await api.setAccountRuntime(kind);        // refresh local API cache
    runtime.value = kind;
    // The model catalog is runtime-specific (omp and claude expose different models) and the
    // orchestrator caches it; force a refetch so every picker offers the new runtime's models
    // instead of the previous runtime's stale list.
    await useOrchestrator().loadModels(true);
  }

  return { client, user, profile, accessToken, runtime, ready, init, signInWithGithub, signOut, chooseRuntime };
});
