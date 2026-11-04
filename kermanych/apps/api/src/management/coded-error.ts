// apps/api/src/management/coded-error.ts
// A domain failure that names WHY it happened with a stable `code` the UI can localize,
// while carrying the Ukrainian sentence as its `message` so a build that does not know the
// code still shows readable prose. The management endpoints turn it into a
// BadRequestException whose body is `{ code, message, params }` (see `badRequest`), and the
// UI re-renders it in the operator's locale from `code`+`params`, falling back to `message`.
import { BadRequestException } from "@nestjs/common";
import type { ApiErrorBody, ApiErrorCode, ApiErrorParams } from "@kermanych/core";

export class CodedError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly params?: ApiErrorParams,
  ) {
    super(message);
    this.name = "CodedError";
  }
}

// The 400 an api boundary throws when it refuses a request — either from an explicit
// validation or by relaying a `CodedError` a service threw. The body is the `ApiErrorBody`
// verbatim — `message` is the fallback prose, `code`/`params` localize it — and Nest sends
// it as-is with a 400 status.
export function badRequest(code: ApiErrorCode, message: string, params?: ApiErrorParams): BadRequestException {
  const body: ApiErrorBody = { code, message, ...(params && Object.keys(params).length ? { params } : {}) };
  return new BadRequestException(body);
}

// A service failure relayed as a 400. A missing `omp`, a start timeout, an unbound project,
// an unknown branch or an empty range are all operator-actionable sentences already; a 500
// would hide every one of them behind "Internal Server Error" and the screen would have
// nothing to show. A `CodedError` carries its stable code on to the body so the UI can
// localize it; anything else keeps its prose.
export function relay(err: unknown): never {
  if (err instanceof CodedError) throw badRequest(err.code, err.message, err.params);
  throw new BadRequestException((err as Error).message);
}
