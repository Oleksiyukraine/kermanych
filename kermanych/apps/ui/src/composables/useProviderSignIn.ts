import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { api } from '../lib/api';
import { installReconcile } from '../lib/reconcile';
import { needsSignIn } from '../lib/session-auth';
import { useAuth } from '../stores/auth';
import { useOrchestrator } from '../stores/orchestrator';

// Whether the AI provider CLI behind the operator's runtime (claude or omp) is signed out on
// this machine. The answer is the sign-out code (`claude_not_authenticated` /
// `omp_not_authenticated`), or undefined while signed in or unknown. It drives the top bar's
// «AI login required» pill: before this, a signed-out machine said nothing until a session
// sat at «Launching…» and never answered.
//
// Sources, in the order they can know:
//   * a session that just died of a sign-out (`Session.errorCode`) sets it at once;
//   * the api's preflight (GET /account/runtime/check) confirms or clears it on mount, when
//     the runtime changes, every 5 minutes while visible, when the window regains focus (the
//     operator ran `claude /login` in a terminal and came back, at most once per 30 s), and
//     on `recheck()` (a click on the pill).
// Only a coded sign-out shows. A timeout, a missing binary or an api that is down leaves the
// last answer standing: a wrong «log in» sends the operator to fix the wrong thing.
const POLL_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 30_000;

export function useProviderSignIn(): { code: Ref<string | undefined>; recheck: () => void } {
  const code = ref<string | undefined>(undefined);
  const auth = useAuth();
  const store = useOrchestrator();
  let stopped = false;
  let inflight = false;
  let lastCheck = 0;
  let stopPoll: (() => void) | undefined;
  let stopRuntimeWatch: (() => void) | undefined;

  async function check(): Promise<void> {
    const runtime = auth.runtime;
    if (!runtime || inflight || stopped) return;
    inflight = true;
    lastCheck = Date.now();
    try {
      const verdict = await api.checkAccountRuntime(runtime);
      if (stopped || runtime !== auth.runtime) return;
      if (verdict.ok) code.value = undefined;
      else if (needsSignIn(verdict.code)) code.value = verdict.code;
    } catch {
      /* api down or restarting — keep the last answer */
    } finally {
      inflight = false;
      // The runtime switched while this check ran: its answer was dropped, so ask again.
      if (!stopped && runtime !== auth.runtime) void check();
    }
  }

  function onFocus(): void {
    if (Date.now() - lastCheck >= FOCUS_MIN_GAP_MS) void check();
  }

  onMounted(async () => {
    // The local api is guarded: an unauthorised read there signs the user out.
    await auth.ready;
    if (stopped) return;
    // Created after an await, so outside the component's scope: stopped by hand below.
    stopRuntimeWatch = watch(
      () => auth.runtime,
      () => {
        code.value = undefined;
        void check();
      },
      { immediate: true },
    );
    stopPoll = installReconcile(() => void check(), { intervalMs: POLL_MS });
    window.addEventListener('focus', onFocus);
  });

  // A session that died of a sign-out is the freshest evidence there is; the next preflight
  // clears it once the operator has logged in. Each death counts once: `dead` holds the
  // sessions currently in that state, so one that respawns and dies again counts again.
  let dead = new Set<string>();
  watch(
    () => store.sessions,
    (list) => {
      const current = new Set<string>();
      for (const s of list) {
        if (s.status !== 'error' || !needsSignIn(s.errorCode)) continue;
        current.add(s.id);
        if (!dead.has(s.id)) code.value = s.errorCode;
      }
      dead = current;
    },
    { immediate: true },
  );

  onUnmounted(() => {
    stopped = true;
    stopRuntimeWatch?.();
    stopPoll?.();
    window.removeEventListener('focus', onFocus);
  });

  return { code, recheck: () => void check() };
}
