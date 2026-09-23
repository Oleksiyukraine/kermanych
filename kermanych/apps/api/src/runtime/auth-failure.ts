// apps/api/src/runtime/auth-failure.ts
// A dead runtime child's own message → a notice code the UI can localize.
//
// This exists because the two failures an operator can actually FIX — "you are signed out"
// and "the binary never installed" — arrived as raw English text from a separately-versioned
// SDK, which is indistinguishable from a provider outage at a glance. Naming them lets the
// UI print the one command that repairs the machine instead of a stack-trace tail.
//
// Pattern matching on a child's prose is admittedly brittle, and that is why the fallback is
// `undefined` rather than a guess: an unrecognised failure keeps its own raw text, which is
// always more informative than a confident wrong cause. A mislabelled provider outage would
// send the operator to re-login for nothing.

// `/login` and `omp login` are matched in their COMMAND form, not on the bare word "login":
// a session about a login form, or a failing login test, must not read as an auth failure.
const CLAUDE_AUTH = /invalid api key|please run \/login|run \/login|oauth|unauthorized|not logged in|not authenticated/i;
const CLAUDE_BINARY = /native binary not found|executable not found/i;
const OMP_AUTH = /omp login|not authenticated|unauthorized|invalid api key/i;
const OMP_BINARY = /spawn omp enoent|enoent.*\bomp\b|\bomp\b.*enoent/i;

export type AuthFailureCode =
  | "claude_not_authenticated"
  | "claude_binary_missing"
  | "omp_not_authenticated"
  | "omp_binary_missing";

// The message is classified by backend first, then by cause, so an omp failure never yields a
// "run claude /login" instruction. `claude` is identified by the SDK's own prefix ("Claude
// Code ..."), which every message in its failure path carries.
export function authFailureCode(message: string): AuthFailureCode | undefined {
  if (!message.trim()) return undefined;
  const isClaude = /claude code/i.test(message);
  if (isClaude) {
    if (CLAUDE_BINARY.test(message)) return "claude_binary_missing";
    if (CLAUDE_AUTH.test(message)) return "claude_not_authenticated";
    return undefined;
  }
  if (OMP_BINARY.test(message)) return "omp_binary_missing";
  if (OMP_AUTH.test(message)) return "omp_not_authenticated";
  return undefined;
}
