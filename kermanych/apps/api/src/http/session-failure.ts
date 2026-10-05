// apps/api/src/http/session-failure.ts
// The single `catch` every sessions endpoint funnels a supervisor failure through.
//
// It exists because the endpoints used to keep only `(err as Error).message`, which threw away
// the one thing a runtime had already worked out: WHY the machine's agent backend is unusable.
// A signed-out CLI and a provider outage arrived as the same anonymous 400, so the operator was
// told a session failed but never that `claude /login` would fix it.
import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES, type ApiErrorBody, type ApiErrorCode } from "@kermanych/core";
import { badRequest, CodedError } from "../management/coded-error";

// A runtime's launch-failure cause → the ApiErrorCode the UI localizes. The runtime names the
// FAULT (`claude_not_authenticated`); the endpoint names the CONSEQUENCE (the launch was
// refused), which is why the codes differ by a `runtime_` prefix rather than being shared with
// the mid-session notice codes of the same names.
const LAUNCH_CODES: Record<string, ApiErrorCode> = {
  claude_not_authenticated: "runtime_claude_not_authenticated",
  claude_binary_missing: "runtime_claude_binary_missing",
  omp_not_authenticated: "runtime_omp_not_authenticated",
  omp_binary_missing: "runtime_omp_binary_missing",
};

// A supervisor failure as a 400. A `CodedError` (e.g. a native session's `native_busy`) and a
// runtime launch failure become a coded `ApiErrorBody`; every other failure keeps the exact
// plain-message shape these endpoints have always returned, so no existing client sees a
// changed body. The prose is always the `message` fallback — a UI that does not know the code
// still shows something actionable.
export function sessionFailure(err: unknown): BadRequestException {
  if (err instanceof CodedError) return badRequest(err.code, err.message, err.params);
  const message = (err as Error)?.message ?? "session failed";
  const cause = err && typeof err === "object" && "code" in err ? err.code : undefined;
  const code =
    typeof cause !== "string"
      ? undefined
      : (LAUNCH_CODES[cause] ?? ((API_ERROR_CODES as readonly string[]).includes(cause) ? (cause as ApiErrorCode) : undefined));
  if (!code) return new BadRequestException(message);
  const body: ApiErrorBody = { code, message };
  return new BadRequestException(body);
}
