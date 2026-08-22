import { clampLines, toolDisplay, type RpcEvent, type ToolLine, type TranscriptEntry } from "@kermanych/core";

export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

export type ReduceOpts = {
  now?: (seq: number) => number;
  textBuf?: string;
  thinkBuf?: string;
  startedAt?: Map<string, number>;
  // The start frame's args, kept for the same lifetime as `startedAt`: omp does not repeat
  // them on the result, yet reducers need them there too — `$ <command>` in a bash card is
  // the whole point of opening it.
  pendingArgs?: Map<string, Record<string, unknown>>;
};

export type Reduced = { entries: TranscriptEntry[]; full: Map<string, ToolLine[]>; textBuf: string; thinkBuf: string };

// omp splits a tool result into content blocks; they are consecutive chunks of the same
// output, so the join has to be the same on the live and the history path or the two
// would disagree on line counts for any multi-block result.
export function joinResultText(content: { text?: string }[] | undefined): string {
  return (content ?? []).map((c) => c.text ?? "").join("\n");
}

// The call side of a tool row. Deriving the target here is what makes it deterministic:
// it never depends on what the result happened to report.
export function pendingToolEntry(id: string, at: number, tool: string, args: Record<string, unknown> | undefined, intent?: string): ToolEntry {
  // No recorded arguments means there is nothing to derive a target from. Asking the
  // display reducers with an empty object would invent one — grep answers "//" — and that
  // would later clobber the good target on a row whose start frame we did see.
  const target = args ? toolDisplay(tool, args, undefined, "").target : undefined;
  return {
    kind: "tool", id, at, tool, status: "pending",
    ...(intent === undefined ? {} : { intent }),
    ...(target ? { target } : {}),
  };
}

// The result side. Both the live stream and rehydrated history call this on an entry built
// by `pendingToolEntry`, with the same call args, which is what makes a reloaded session
// render identically to the one that streamed. Returns the unclamped lines for the cache.
export function applyToolResult(
  entry: ToolEntry,
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  content: string,
  isError: boolean,
): ToolLine[] {
  const d = toolDisplay(entry.tool, args, details, content);
  entry.status = isError ? "error" : "ok";
  if (d.stat !== undefined) entry.stat = d.stat;
  if (d.count !== undefined) entry.count = d.count;
  // `edit` is the one tool whose result reports an authoritative repo-relative path, and it
  // is better than the call-side one. Every other target stays as the call derived it —
  // deterministic, and independent of whether the result frame happened to echo a path.
  if (entry.tool === "edit" && typeof details?.["path"] === "string" && details["path"]) entry.target = d.target;
  entry.detail = {
    lines: clampLines(entry.tool, d.lines),
    totalLines: d.totalLines,
    ...(d.truncatedUpstream ? { truncatedUpstream: true } : {}),
  };
  return d.lines;
}

// The single reduction from omp's event stream to transcript entries. Kept pure and
// exported so both the live supervisor and the tests drive the identical code path.
//
// The streaming state that cannot live inside one call — the partial assistant text, the
// tool start times and the tool call args — is passed in and handed back: the service owns
// one set per live session, the tests hand a whole event run to a single call and let it
// own its own.
export function reduceRpcEvents(events: RpcEvent[], opts?: ReduceOpts): Reduced {
  const entries: TranscriptEntry[] = [];
  const full = new Map<string, ToolLine[]>();
  const startedAt = opts?.startedAt ?? new Map<string, number>();
  const pendingArgs = opts?.pendingArgs ?? new Map<string, Record<string, unknown>>();
  let seq = 0;
  let textBuf = opts?.textBuf ?? "";
  let thinkBuf = opts?.thinkBuf ?? "";
  // Entry ids are derived from the stamp, not from `seq`: the live service reduces one
  // event per call, so a per-call counter would hand every turn the same id.
  const stamp = () => (opts?.now ? opts.now(++seq) : Date.now());

  for (const e of events) {
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete typed member.
    if (e.type === "message_update") {
      const ame = (e as Extract<RpcEvent, { type: "message_update" }>).assistantMessageEvent;
      if (ame?.type === "text_delta") textBuf += ame.delta ?? "";
      else if (ame?.type === "thinking_delta") thinkBuf += ame.delta ?? "";
      continue;
    }
    if (e.type === "message_end") {
      const m = (e as Extract<RpcEvent, { type: "message_end" }>).message;
      // toolResult messages repeat what tool_execution_end already delivered.
      if (m?.role === "toolResult") continue;
      const at = stamp();
      if (thinkBuf.trim())
        entries.push({
          kind: "assistant_thinking", id: `k${at}`, at, text: thinkBuf,
          ...(m?.duration === undefined ? {} : { ms: m.duration }),
          ...(m?.usage?.output === undefined ? {} : { tokens: m.usage.output }),
        });
      if (textBuf.trim()) entries.push({ kind: "assistant_text", id: `a${at}`, at, text: textBuf });
      // The turn entry renders no row of its own — it carries the per-turn cost and token
      // counts that the block footer sums.
      if (m?.role === "assistant")
        entries.push({
          kind: "turn", id: `r${at}`, at,
          ...(m.model === undefined ? {} : { model: m.model }),
          ...(m.duration === undefined ? {} : { ms: m.duration }),
          usage: {
            input: m.usage?.input ?? 0, output: m.usage?.output ?? 0,
            cacheRead: m.usage?.cacheRead ?? 0, cacheWrite: m.usage?.cacheWrite ?? 0,
            cost: m.usage?.cost?.total ?? 0,
          },
        });
      textBuf = "";
      thinkBuf = "";
      continue;
    }
    if (e.type === "tool_execution_start") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_start" }>;
      const at = stamp();
      const id = ev.toolCallId ?? `t${at}`;
      startedAt.set(id, at);
      if (ev.args) pendingArgs.set(id, ev.args);
      entries.push(pendingToolEntry(id, at, ev.toolName ?? "?", ev.args, ev.intent));
      continue;
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      const tool = ev.toolName ?? "?";
      const at = stamp();
      // Match by exact toolCallId when omp provides one, else the oldest pending entry of
      // the same tool name (FIFO — correct for interchangeable parallel calls). Nothing
      // pending means the start frame landed in an earlier call: emit a completed entry
      // and let the caller patch its own copy of the row.
      const found =
        (ev.toolCallId ? entries.find((x) => x.kind === "tool" && x.id === ev.toolCallId) : undefined) ??
        entries.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      const entry: ToolEntry =
        found?.kind === "tool" ? found : pendingToolEntry(ev.toolCallId ?? `t${at}`, at, tool, undefined);
      const started = startedAt.get(entry.id);
      if (started !== undefined) {
        entry.ms = at - started;
        startedAt.delete(entry.id);
      }
      const args = pendingArgs.get(entry.id);
      pendingArgs.delete(entry.id);
      const lines = applyToolResult(entry, args, ev.result?.details, joinResultText(ev.result?.content), ev.isError === true);
      if (lines.length) full.set(entry.id, lines);
      if (found?.kind !== "tool") entries.push(entry);
      continue;
    }
    if (e.type === "notice") {
      const text = (e as Extract<RpcEvent, { type: "notice" }>).message ?? "";
      if (!text.trim()) continue;
      const at = stamp();
      entries.push({ kind: "notice", id: `n${at}`, at, level: "info", text });
      continue;
    }
  }
  return { entries, full, textBuf, thinkBuf };
}
