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
