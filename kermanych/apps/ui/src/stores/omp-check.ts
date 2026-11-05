// apps/ui/src/stores/omp-check.ts
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '../lib/api';
import { installReconcile } from '../lib/reconcile';
import { needsSignIn } from '../lib/session-auth';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';

// Whether omp — which runs «Керманич» and every headless AI function of Kermanych (Менеджмент,
// ЦУК, release notes, Slack, branch names) — is usable on this machine. One verdict, shared by
// the top bar's «Потрібен вхід в omp» pill (MainLayout) and the blocking notes above the ЦУК
// and Менеджмент inputs (docs/specs/2026-11-05-remove-managed-claude-code.md, decisions 7-8).
//
// `code` is `omp_not_authenticated` or `omp_binary_missing`, or undefined while omp works or
// the answer is unknown. Sources, in the order they can know:
//   * a session that just died of an omp sign-out (`Session.errorCode`) sets it at once;
//   * the api's check (GET /account/runtime/check) confirms or clears it once signed in,
//     every 5 minutes while visible, when the window regains focus (the operator ran
//     `omp login` in a terminal and came back, at most once per 30 s), and on `recheck()`.
// Only a coded cause counts. A timeout, an unclassified failure or an api that is down leaves
// the last answer standing: a wrong «log in» sends the operator to fix the wrong thing.
const POLL_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 30_000;

export type OmpProblem = 'omp_not_authenticated' | 'omp_binary_missing';

function isOmpProblem(code: string | undefined): code is OmpProblem {
  return code === 'omp_not_authenticated' || code === 'omp_binary_missing';
}

export const useOmpCheck = defineStore('omp-check', () => {
  const code = ref<OmpProblem | undefined>(undefined);
  const auth = useAuth();
  const store = useOrchestrator();
  let inflight = false;
  let lastCheck = 0;

  // The pill names only a sign-out; the blocking notes also act on a missing binary.
  const signedOut = computed(() => code.value === 'omp_not_authenticated');
  const blocked = computed(() => code.value !== undefined);

  async function check(): Promise<void> {
    // The local api is guarded: an unauthorised read there signs the user out.
    if (!auth.user || inflight) return;
    inflight = true;
    lastCheck = Date.now();
    try {
      const verdict = await api.checkAccountRuntime();
      if (verdict.ok) code.value = undefined;
      else if (isOmpProblem(verdict.code)) code.value = verdict.code;
    } catch {
      /* api down or restarting — keep the last answer */
    } finally {
      inflight = false;
    }
  }

  function onFocus(): void {
    if (Date.now() - lastCheck >= FOCUS_MIN_GAP_MS) void check();
  }

  // Starts the refresh rules; the returned function stops them. MainLayout owns the lifecycle,
  // so the checks run once per window however many surfaces read the verdict.
  function start(): () => void {
    let stopped = false;
    let stopUserWatch: (() => void) | undefined;
    let stopPoll: (() => void) | undefined;
    void auth.ready.then(() => {
      if (stopped) return;
      stopUserWatch = watch(
        () => auth.user?.id,
        (id) => {
          code.value = undefined;
          if (id) void check();
        },
        { immediate: true },
      );
      stopPoll = installReconcile(() => void check(), { intervalMs: POLL_MS });
      window.addEventListener('focus', onFocus);
    });
    return () => {
      stopped = true;
      stopUserWatch?.();
      stopPoll?.();
      window.removeEventListener('focus', onFocus);
    };
  }

  // A session that died of an omp sign-out is the freshest evidence there is; the next check
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
        if (!dead.has(s.id)) code.value = 'omp_not_authenticated';
      }
      dead = current;
    },
    { immediate: true },
  );

  return { code, signedOut, blocked, start, recheck: () => void check() };
});
