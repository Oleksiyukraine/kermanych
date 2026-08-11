// Single source of truth for the inline summary of a tool call. Both the live
// supervisor and the history mapper derive their call summary from here, so the
// two paths render identically. Precedence runs from the most specific argument
// to the near-universal `i` intent, then any caller-supplied fallback intent.
export function toolCallSummary(
  args: Record<string, unknown> | undefined,
  fallbackIntent?: string,
): string | undefined {
  const a = args ?? {};
  for (const key of ["command", "path", "pattern", "query", "i"]) {
    if (typeof a[key] === "string") return a[key] as string;
  }
  return fallbackIntent;
}
