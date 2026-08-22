import { clampLines, toolDisplay, type RpcEvent, type ToolLine, type TranscriptEntry } from "@kermanych/core";

export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
export type TurnEntry = Extract<TranscriptEntry, { kind: "turn" }>;

// The per-turn accounting omp reports when an assistant message closes.
export type TurnMeta = {
  model?: string;
  duration?: number;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
};

// A `turn` renders no row of its own: `buildChatBlocks` folds `usage.cost` into the collapsed
// block footer. Rehydrated history must rebuild it through this same builder, or every footer
// reads 0 after a reload.
export function turnEntry(id: string, at: number, m: TurnMeta): TurnEntry {
  return {
    kind: "turn", id, at,
    ...(m.model === undefined ? {} : { model: m.model }),
    ...(m.duration === undefined ? {} : { ms: m.duration }),
    usage: {
      input: m.usage?.input ?? 0, output: m.usage?.output ?? 0,
      cacheRead: m.usage?.cacheRead ?? 0, cacheWrite: m.usage?.cacheWrite ?? 0,
      cost: m.usage?.cost?.total ?? 0,
    },
  };
}

// Whether omp reported any turn accounting at all. A history message that carries none must
// not produce a turn of zeros — that would assert the turn was free rather than unrecorded.
export function hasTurnMeta(m: TurnMeta | undefined): m is TurnMeta {
  return m !== undefined && (m.model !== undefined || m.duration !== undefined || m.usage !== undefined);
}

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

// omp splits a tool result into content blocks; the text ones are consecutive chunks of the
// same output. Both the filter and the join live here, so neither caller can pass a
// differently-prepared list and make an image block cost the live side a phantom blank row.
export function joinResultText(content: { type?: string; text?: string }[] | undefined): string {
  return (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
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
      if (m?.role === "assistant") entries.push(turnEntry(`r${at}`, at, m));
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
      const ev = e as Extract<RpcEvent, { type: "notice" }>;
      const text = ev.message ?? "";
      if (!text.trim()) continue;
      const at = stamp();
      // omp spells it `warning`, the transcript union spells it `warn`; anything else omp
      // adds later reads as `info` rather than leaking an unknown value into a typed field.
      const level = ev.level === "warn" || ev.level === "warning" ? "warn" : ev.level === "error" ? "error" : "info";
      entries.push({ kind: "notice", id: `n${at}`, at, level, text });
      continue;
    }
  }
  return { entries, full, textBuf, thinkBuf };
}
