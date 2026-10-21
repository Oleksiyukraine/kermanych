// apps/ui/src/lib/session-auth.ts
// «Login required»: the AI provider CLI behind a session (claude or omp) is signed out on this
// machine. The api names it with a cause code — on a session that died of it
// (`Session.errorCode`) and in the preflight's verdict (GET /account/runtime/check) — and
// every surface that shows a status keys the words «login required» on this one predicate.
// A missing binary or an unknown failure is NOT a sign-out: a wrong «log in» sends the
// operator to fix the wrong thing.
export function needsSignIn(code: string | undefined): boolean {
  return code === 'claude_not_authenticated' || code === 'omp_not_authenticated';
}
