// apps/api/src/runtime/auth-failure.ts
// A dead runtime child's own message → a notice code the UI can localize.
//
// This exists because the two failures an operator can actually FIX — "you are signed out"
// and "the binary never installed" — arrived as raw English text from a separately-versioned
// child, which is indistinguishable from a provider outage at a glance. Naming them lets the
// UI print the one command that repairs the machine instead of a stack-trace tail.
//
// Pattern matching on a child's prose is admittedly brittle, and that is why the fallback is
// `undefined` rather than a guess: an unrecognised failure keeps its own raw text, which is
// always more informative than a confident wrong cause. A mislabelled provider outage would
// send the operator to re-login for nothing.

// `omp login` is matched in its COMMAND form, not on the bare word "login": a session about
// a login form, or a failing login test, must not read as an auth failure.
// "No models available. Use /login or set an API key…" is what a signed-out omp prints before
// it exits (omp 18.2.11): with no provider credentials it has no model to run.
const OMP_AUTH = /omp login|not authenticated|unauthorized|invalid api key|no models available/i;
const OMP_BINARY = /spawn omp enoent|enoent.*\bomp\b|\bomp\b.*enoent/i;

export type AuthFailureCode = "omp_not_authenticated" | "omp_binary_missing";

// A failure whose cause is already known from a structured signal, so nothing re-reads its prose.
export class AuthFailure extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export function authFailureCode(message: string): AuthFailureCode | undefined {
  if (!message.trim()) return undefined;
  if (OMP_BINARY.test(message)) return "omp_binary_missing";
  if (OMP_AUTH.test(message)) return "omp_not_authenticated";
  return undefined;
}
