// routines-runner/failure.ts — a run that cannot finish, said the way the run history words
// it: a `code` the Routines screen localizes (packages/core ROUTINE_RUN_REASONS, or an api
// error code such as `no_commits_in_range`), an English sentence as the fallback, and the
// values the localized sentence interpolates. `skip` marks a run with nothing to do (a quiet
// period) rather than one that failed.
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params: Record<string, string | number> = {},
    readonly skip = false,
  ) {
    super(message);
    this.name = "RunFailure";
  }
}
