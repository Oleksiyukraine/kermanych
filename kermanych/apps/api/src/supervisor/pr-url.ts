// apps/api/src/supervisor/pr-url.ts
import type { ToolLine, TranscriptEntry } from "@kermanych/core";

// A pull-request URL — the signal that a «Створити ПР» flow actually opened one: GitHub
// `/pull/N`, GitLab `/-/merge_requests/N`, Bitbucket `/pull-requests/N`. Non-global so
// `.test`/`.exec` stay stateless across the many messages one turn streams. Shared by the managed
// event stream (supervisor.service.ts) and the native session-file reader
// (native/native-session.service.ts).
export const PR_URL_RE = /https?:\/\/\S+\/(?:pull|pull-requests|merge_requests)\/\d+/i;

// The first PR URL in a stretch of transcript — the agent's reply or a `gh pr create` tool
// result, in order. Both readers persist it as `prUrl` together with `prOpened`
// (docs/specs/2026-10-26-pr-merged-close-prompt.md, decision 4).
export function firstPrUrl(entries: TranscriptEntry[], full: Map<string, ToolLine[]>): string | undefined {
  for (const e of entries) {
    if (e.kind === "assistant_text") {
      const m = PR_URL_RE.exec(e.text);
      if (m) return m[0];
    }
    if (e.kind === "tool") {
      for (const ln of full.get(e.id) ?? []) {
        const m = "text" in ln ? PR_URL_RE.exec(ln.text) : null;
        if (m) return m[0];
      }
    }
  }
  return undefined;
}
