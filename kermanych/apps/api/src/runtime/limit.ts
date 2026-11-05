// apps/api/src/runtime/limit.ts
// RpcSession bounds its command round trips (`commandTimeoutMs`) but neither `start()` nor
// a turn, and neither does omp bound a provider request that never answers. Without this
// the http request would stay open until the browser gave up, with nothing the operator
// could read or act on. Shared by the management chat and runOneShot (one-shot.ts).
//
// Its own module, not the management chat's: one-shot.ts reaches the supervisor through the
// branch namer, and importing the chat from there closed an import cycle through the Jira
// tools back to SupervisorService, leaving JiraService's constructor types undefined.
export async function limit<T>(p: Promise<T>, ms: number, onTimeout: Error): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(onTimeout), ms);
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
