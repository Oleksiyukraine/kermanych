import { clampLines, toolDisplay, type RpcEvent, type ToolLine, type TranscriptEntry, type Usage } from "@kermanych/core";

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

// The plan spend of one whole turn, summed across its `message_end` frames: a turn that
// called three tools closes four assistant messages, and reporting only the last one would
// tell the operator a long turn was nearly free. Shared by the management chat and the
// release-notes generator, so both report a turn's cost with the same arithmetic.
export type TurnSpend = { usage?: Usage; model?: string };

export function sumTurnUsage(events: RpcEvent[], at: number): TurnSpend {
  let usage: Usage | undefined;
  let model: string | undefined;
  for (const e of events) {
    if (e.type !== "message_end") continue;
    // RpcEvent carries an index-signature fallback member; Extract recovers the concrete
    // typed member, exactly as reduceRpcEvents does for the same frame.
    const m = (e as Extract<RpcEvent, { type: "message_end" }>).message;
    if (m?.role !== "assistant" || !hasTurnMeta(m)) continue;
    const t = turnEntry("turn", at, m);
    if (t.model !== undefined) model = t.model;
    const u = t.usage;
    if (!u) continue;
    usage = usage
      ? {
          input: usage.input + u.input,
          output: usage.output + u.output,
          cacheRead: usage.cacheRead + u.cacheRead,
          cacheWrite: usage.cacheWrite + u.cacheWrite,
          cost: usage.cost + u.cost,
        }
      : u;
  }
  return { ...(usage === undefined ? {} : { usage }), ...(model === undefined ? {} : { model }) };
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
  // Resolves a skill name to its source badge. Injected by the supervisor from the
  // materialised library, so this module stays pure.
  skillSource?: SkillSource;
};

export type Reduced = { entries: TranscriptEntry[]; full: Map<string, ToolLine[]>; textBuf: string; thinkBuf: string };

// omp splits a tool result into content blocks; the text ones are consecutive chunks of the
// same output. Both the filter and the join live here, so neither caller can pass a
// differently-prepared list and make an image block cost the live side a phantom blank row.
export function joinResultText(content: { type?: string; text?: string }[] | undefined): string {
  return (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

// The source badge for a skill row: `stat` shows collapsed (KToolRow renders tool/target/stat
// on the closed row), `intent` only when the row is expanded, so the badge belongs in `stat`
// and the file path in `intent`.
export type SkillLabel = { stat?: string; intent?: string };
export type SkillSource = (name: string) => SkillLabel | undefined;

// omp has no dedicated tool for skills: a skill is used by reading `skill://<name>`. The
// transcript renames that row so it reads as a skill and never coalesces with file reads
// (COALESCE_TOOLS covers `read`). Returns undefined for anything that is not a skill read.
export function skillNameFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  const p = args?.["path"];
  if (typeof p !== "string" || !p.startsWith("skill://")) return undefined;
  // `skill://<name>/<sub-path>` is still a read of `<name>`: only the first segment is the
  // library key, while the full remainder stays the row's target (core's `skillDisplay`
  // owns that), so a sub-resource read resolves the same badge as the skill itself.
  const name = p.slice("skill://".length).split("/")[0];
  return name || undefined;
}

// Whether a pending row belongs to the tool named on the wire. The one rule three places
// need — the live reducer, the rehydration path and the service's `finishTool` — because a
// `read` on the wire may have been renamed to `skill` on the row, and a frame with no
// toolCallId leaves the tool name as the only thing left to match on.
export function toolRowMatches(rowTool: string, wireTool: string): boolean {
  return rowTool === wireTool || (wireTool === "read" && rowTool === "skill");
}

// The call side of a tool row. Deriving the target here is what makes it deterministic:
// it never depends on what the result happened to report.
export function pendingToolEntry(
  id: string,
  at: number,
  tool: string,
  args: Record<string, unknown> | undefined,
  intent?: string,
  skillSource?: SkillSource,
): ToolEntry {
  // The rename lives HERE, not at the call sites, because both the live stream and the
  // rehydration path build rows through this function: parity depends on one rule.
  const skill = tool === "read" ? skillNameFromArgs(args) : undefined;
  const effective = skill ? "skill" : tool;
  const label = skill ? skillSource?.(skill) : undefined;
  // No recorded arguments means there is nothing to derive a target from. Asking the
  // display reducers with an empty object would invent one — grep answers "//" — and that
  // would later clobber the good target on a row whose start frame we did see.
  const target = args ? toolDisplay(effective, args, undefined, "").target : undefined;
  return {
    kind: "tool", id, at, tool: effective, status: "pending",
    ...((label?.intent ?? intent) === undefined ? {} : { intent: (label?.intent ?? intent) as string }),
    ...(label?.stat ? { stat: label.stat } : {}),
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
  // The stat is whatever the reducer named and nothing else. A reducer that carries no stat
  // — an unknown tool, a `hub` frame without an op — leaves the cell bare, which is the row
  // the spec sanctions. Standing the wall time in here would break parity: only
  // `reduceRpcEvents` sets `entry.ms`, so such a row would show a figure while streaming
  // and lose it after a resume.
  if (d.stat) entry.stat = d.stat;
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
      entries.push(pendingToolEntry(id, at, ev.toolName ?? "?", ev.args, ev.intent, opts?.skillSource));
      continue;
    }
    if (e.type === "tool_execution_end") {
      const ev = e as Extract<RpcEvent, { type: "tool_execution_end" }>;
      const tool = ev.toolName ?? "?";
      const at = stamp();
      // Match by exact toolCallId when omp provides one, else the oldest pending entry of
      // the same tool name (FIFO — correct for interchangeable parallel calls).
      const found =
        (ev.toolCallId ? entries.find((x) => x.kind === "tool" && x.id === ev.toolCallId) : undefined) ??
        entries.find((x) => x.kind === "tool" && x.status === "pending" && toolRowMatches(x.tool, tool));
      // Nothing pending means the start frame landed in an earlier call — the live service
      // reduces one event per call, so that is the normal case, not the exception: emit a
      // completed entry and let the caller patch its own copy of the row. The start frame's
      // args are still retained under its id, and they are what makes the rename — and
      // therefore the display reducer — the same on both frames. A start frame we truly
      // never saw leaves the map empty, so the "empty args invent a target" guard still holds.
      const entry: ToolEntry =
        found?.kind === "tool"
          ? found
          : pendingToolEntry(
              ev.toolCallId ?? `t${at}`,
              at,
              tool,
              ev.toolCallId ? pendingArgs.get(ev.toolCallId) : undefined,
              undefined,
              opts?.skillSource,
            );
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
