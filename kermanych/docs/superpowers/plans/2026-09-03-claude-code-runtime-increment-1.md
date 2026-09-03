# claude-code runtime — Increment 1 (vertical slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one claude-code **agent** session runs end-to-end behind a new `AgentRuntime` abstraction — create → prompt → stream → tool rows → follow-up → steer → stop → resume — with the transcript identical in shape to omp, selected by a temporary dev switch.

**Architecture:** Keep `RpcEvent`/`RpcStateData` as the canonical runtime event/state contract; introduce an `AgentRuntime` interface that the current `RpcSession` satisfies (as `omp`), plus a `ClaudeCodeRuntime` that drives `@anthropic-ai/claude-agent-sdk`'s streaming `query()` and translates its `SDKMessage` stream into `RpcEvent`. A `createRuntime(kind, opts)` factory replaces direct `new RpcSession(...)`. The supervisor picks the kind from `process.env.KERMANYCH_RUNTIME` for this slice (per-user plumbing is Increment 2).

**Tech Stack:** TypeScript, NestJS (`apps/api`), Vitest, `@anthropic-ai/claude-agent-sdk` (spawns the separately-installed `claude` CLI), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-02-claude-code-runtime-design.md`

## Global Constraints

- Node ≥ 22.12 (repo runs Node 24). pnpm is the package manager (`pnpm@10.33.2`).
- Code, identifiers, comments, commit messages: **English**. UI-visible strings: Ukrainian (no UI strings in this increment).
- `@kermanych/core` and `@kermanych/cloud` are consumed as built `dist`; after editing `core`, run `pnpm --filter @kermanych/core build` before typechecking/testing `apps/api`.
- `@kermanych/core` barrel (`packages/core/src/index.ts`) uses **enumerated** re-exports, never `export *` for value modules (cjs-module-lexer requirement noted in that file).
- The canonical runtime event contract is `RpcEvent` (`packages/core/src/types.ts`); every backend emits it. Do not rename it in this increment.
- Do NOT run project-wide formatters/linters. Run only the tests/commands named in each task.
- Frequent commits: one per task, message form `feat(runtime): …` / `test(runtime): …`.
- **SCOPE NOTE:** fork (chat→agent / discussion) is deferred to Increment 3; this slice proves the core loop + resume only. `Session.runtime` persistence + onboarding UI are Increment 2 — this slice selects the runtime via the `KERMANYCH_RUNTIME` env var.

---

## File Structure

- `packages/core/src/runtime.ts` (new) — `AgentRuntimeKind` union + `isAgentRuntime` guard. One responsibility: the runtime-kind vocabulary shared by API and UI.
- `packages/core/src/index.ts` (modify) — export the new symbols.
- `apps/api/src/runtime/agent-runtime.ts` (new) — the `AgentRuntime` interface, the `RpcStateData` contract (moved here), the `RuntimeLaunchOpts` type, and `createRuntime()`.
- `apps/api/src/runtime/effort-map.ts` (new) — pure `ThinkingLevel` ↔ claude `EffortLevel`/`ThinkingConfig` mapping.
- `apps/api/src/runtime/claude-event-map.ts` (new) — pure `SDKMessage → RpcEvent[]` translation with a small carried state.
- `apps/api/src/runtime/claude-code-runtime.ts` (new) — `ClaudeCodeRuntime implements AgentRuntime`; wires `query()` to the event map; injectable `query` seam.
- `apps/api/src/rpc/rpc-session.ts` (modify) — `RpcSession implements AgentRuntime`; import `RpcStateData` from the new home.
- `apps/api/src/supervisor/supervisor.service.ts` (modify) — `Live.rpc: AgentRuntime`; `wireLive` signature; `launch` (≈557) and `doResume` (≈1550) call `createRuntime(...)`; add `runtimeFor()` dev switch.
- `apps/api/package.json` (modify) — add `@anthropic-ai/claude-agent-sdk`.
- Tests: `packages/core/test/runtime.spec.ts`, `apps/api/test/runtime-factory.spec.ts`, `apps/api/test/effort-map.spec.ts`, `apps/api/test/claude-event-map.spec.ts`, `apps/api/test/claude-code-runtime.spec.ts`.

---

## Task 1: runtime-kind vocabulary in `@kermanych/core`

**Files:**
- Create: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/runtime.spec.ts`

**Interfaces:**
- Produces: `AGENT_RUNTIMES: readonly ['omp','claude-code']`, `type AgentRuntimeKind = 'omp' | 'claude-code'`, `isAgentRuntime(v: unknown): v is AgentRuntimeKind`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/runtime.spec.ts
import { describe, it, expect } from "vitest";
import { AGENT_RUNTIMES, isAgentRuntime } from "../src/runtime";

describe("agent runtime kind", () => {
  it("lists exactly omp and claude-code", () => {
    expect([...AGENT_RUNTIMES]).toEqual(["omp", "claude-code"]);
  });
  it("accepts known kinds and rejects everything else", () => {
    expect(isAgentRuntime("omp")).toBe(true);
    expect(isAgentRuntime("claude-code")).toBe(true);
    expect(isAgentRuntime("gpt")).toBe(false);
    expect(isAgentRuntime(undefined)).toBe(false);
    expect(isAgentRuntime(null)).toBe(false);
    expect(isAgentRuntime(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @kermanych/core test -- runtime.spec`
Expected: FAIL — `Cannot find module '../src/runtime'`.

- [ ] **Step 3: Implement the module**

```ts
// packages/core/src/runtime.ts
// The agent-runtime backend a session runs on. Mirrors ThinkingLevel's shape: a frozen
// tuple as the single source of truth, a derived union type, and a boundary guard used
// wherever the value arrives as an unvalidated string (HTTP body, cloud row, env var).
export const AGENT_RUNTIMES = ["omp", "claude-code"] as const;
export type AgentRuntimeKind = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(v: unknown): v is AgentRuntimeKind {
  return typeof v === "string" && (AGENT_RUNTIMES as readonly string[]).includes(v);
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, immediately after the `./thinking` export (line ~46), add:

```ts
export { AGENT_RUNTIMES, isAgentRuntime, type AgentRuntimeKind } from "./runtime";
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @kermanych/core test -- runtime.spec`
Expected: PASS (2 tests).

- [ ] **Step 6: Build core so downstream packages see the new export**

Run: `pnpm --filter @kermanych/core build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/index.ts packages/core/test/runtime.spec.ts
git commit -m "feat(core): add AgentRuntimeKind vocabulary and guard"
```

---

## Task 2: `AgentRuntime` interface, `RpcStateData` move, `RpcSession implements`, factory

**Files:**
- Create: `apps/api/src/runtime/agent-runtime.ts`
- Modify: `apps/api/src/rpc/rpc-session.ts` (move out `RpcStateData` at lines 7-11; add `implements AgentRuntime`)
- Test: `apps/api/test/runtime-factory.spec.ts`

**Interfaces:**
- Consumes: `RpcSession` (existing), `RpcEvent`, `RpcExtensionUIResponse`, `ImageInput`, `ThinkingLevel` from `@kermanych/core`, `AgentRuntimeKind`.
- Produces: `interface AgentRuntime`, `type RpcStateData`, `type RuntimeLaunchOpts`, `createRuntime(kind: AgentRuntimeKind, opts: RuntimeLaunchOpts): AgentRuntime`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/runtime-factory.spec.ts
import { describe, it, expect } from "vitest";
import { createRuntime, type AgentRuntime } from "../src/runtime/agent-runtime";

const REQUIRED_METHODS: (keyof AgentRuntime)[] = [
  "start", "isAlive", "prompt", "followUp", "steer", "answerUi",
  "getState", "switchSession", "setModel", "setThinkingLevel",
  "getAllMessages", "stop", "onEvent", "onExit",
];

describe("createRuntime", () => {
  it("returns an omp runtime exposing the full AgentRuntime surface", () => {
    const rt = createRuntime("omp", { cwd: "/tmp/x" });
    for (const m of REQUIRED_METHODS) {
      expect(typeof (rt as unknown as Record<string, unknown>)[m]).toBe("function");
    }
    expect(rt.isAlive()).toBe(false); // not started
  });

  it("throws a clear error for claude-code until its adapter lands", () => {
    expect(() => createRuntime("claude-code", { cwd: "/tmp/x" })).toThrow(/claude-code runtime not wired/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @kermanych/api test -- runtime-factory`
Expected: FAIL — cannot find `../src/runtime/agent-runtime`.

- [ ] **Step 3: Create the interface + factory**

```ts
// apps/api/src/runtime/agent-runtime.ts
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel, TodoPhase, AgentRuntimeKind } from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";

// The state contract a runtime reports through getState(). Moved here from rpc-session.ts
// because it is backend-neutral: omp fills it from its `get_state` frame, claude from
// system/init + getContextUsage().
export interface RpcStateData {
  isStreaming: boolean;
  contextUsage?: { percent: number };
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  sessionId?: string;
  sessionFile?: string;
  todoPhases?: TodoPhase[];
}

// Normalized launch inputs. omp-only fields (configPath/extensionPath = skill overlay +
// trigger package) are ignored by non-omp backends. `tools`/`noTools` restrict the toolset;
// `fork` seeds from a prior session; `thinking` is the opening effort.
export interface RuntimeLaunchOpts {
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  fork?: string;
  noTools?: boolean;
  tools?: string[];
  commandTimeoutMs?: number;
  configPath?: string;   // omp-only
  extensionPath?: string; // omp-only
}

// The backend-neutral session surface the supervisor drives. Method names match the current
// RpcSession verbatim so the supervisor call sites are unchanged apart from the type.
export interface AgentRuntime {
  start(): Promise<void>;
  isAlive(): boolean;
  readonly droppedFrames: number;
  prompt(message: string, images?: ImageInput[]): void;
  followUp(message: string, images?: ImageInput[]): void;
  steer(message: string, images?: ImageInput[]): void;
  answerUi(res: RpcExtensionUIResponse): void;
  getState(): Promise<RpcStateData>;
  switchSession(sessionPath: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  getAllMessages(): Promise<unknown[]>;
  stop(): Promise<void>;
  onEvent(cb: (e: RpcEvent) => void): void;
  onExit(cb: (code: number | null, reason: string) => void): void;
}

export function createRuntime(kind: AgentRuntimeKind, opts: RuntimeLaunchOpts): AgentRuntime {
  if (kind === "omp") return new RpcSession(opts);
  // Task 5 replaces this throw with `return new ClaudeCodeRuntime(opts);`
  throw new Error(`claude-code runtime not wired yet (kind=${kind})`);
}
```

- [ ] **Step 4: Move `RpcStateData` out of `rpc-session.ts` and add the `implements` clause**

In `apps/api/src/rpc/rpc-session.ts`:
- Delete the local `export interface RpcStateData { … }` (lines 7-11).
- Add to the imports at the top: `import type { AgentRuntime, RpcStateData } from "../runtime/agent-runtime";`
- Change the class declaration `export class RpcSession {` to `export class RpcSession implements AgentRuntime {`.

(The type-only import is safe against the value import cycle: `agent-runtime.ts` imports the `RpcSession` *value*; `rpc-session.ts` imports only *types* back.)

- [ ] **Step 5: Run the factory test and the existing rpc-session tests**

Run: `pnpm --filter @kermanych/api test -- runtime-factory rpc-session`
Expected: `runtime-factory` PASS (2 tests); `rpc-session*` suites still PASS (unchanged behavior). If `tsc`/vitest reports RpcSession does not satisfy `AgentRuntime`, reconcile the offending signature (it should already match; `droppedFrames` is a public field).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/runtime/agent-runtime.ts apps/api/src/rpc/rpc-session.ts apps/api/test/runtime-factory.spec.ts
git commit -m "feat(runtime): AgentRuntime interface + factory; RpcSession implements it"
```

---

## Task 3: effort mapping (pure)

**Files:**
- Create: `apps/api/src/runtime/effort-map.ts`
- Test: `apps/api/test/effort-map.spec.ts`

**Interfaces:**
- Consumes: `ThinkingLevel` from `@kermanych/core`; `EffortLevel`, `ThinkingConfig` from `@anthropic-ai/claude-agent-sdk` (types only).
- Produces: `toClaudeEffort(level: ThinkingLevel): EffortLevel | null`, `toClaudeThinking(level: ThinkingLevel): ThinkingConfig`, `fromClaudeEffort(effort: EffortLevel | null | undefined): ThinkingLevel`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/effort-map.spec.ts
import { describe, it, expect } from "vitest";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "../src/runtime/effort-map";

describe("effort mapping", () => {
  it("maps the omp ladder to claude effort (off disables, minimal->low, rest 1:1)", () => {
    expect(toClaudeEffort("off")).toBeNull();
    expect(toClaudeEffort("minimal")).toBe("low");
    expect(toClaudeEffort("low")).toBe("low");
    expect(toClaudeEffort("medium")).toBe("medium");
    expect(toClaudeEffort("high")).toBe("high");
    expect(toClaudeEffort("xhigh")).toBe("xhigh");
    expect(toClaudeEffort("max")).toBe("max");
  });
  it("disables thinking only for off", () => {
    expect(toClaudeThinking("off")).toEqual({ type: "disabled" });
    expect(toClaudeThinking("high")).toEqual({ type: "adaptive" });
  });
  it("reads claude effort back into the omp ladder (missing -> off)", () => {
    expect(fromClaudeEffort(undefined)).toBe("off");
    expect(fromClaudeEffort(null)).toBe("off");
    expect(fromClaudeEffort("medium")).toBe("medium");
    expect(fromClaudeEffort("max")).toBe("max");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @kermanych/api test -- effort-map`
Expected: FAIL — cannot find `../src/runtime/effort-map`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/runtime/effort-map.ts
import type { ThinkingLevel } from "@kermanych/core";
import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

// omp's 7-rung ladder collapses onto claude's 5 effort levels. `off` disables thinking and
// carries no effort; `minimal` (no claude counterpart) folds to `low`; the top five are 1:1.
export function toClaudeEffort(level: ThinkingLevel): EffortLevel | null {
  switch (level) {
    case "off": return null;
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "xhigh";
    case "max": return "max";
  }
}

export function toClaudeThinking(level: ThinkingLevel): ThinkingConfig {
  return level === "off" ? { type: "disabled" } : { type: "adaptive" };
}

// claude reports its effort; the five values are all valid ThinkingLevel members, so a
// non-null effort passes through, and absence reads as `off`. A session launched at
// `minimal` reads back as `low` — accepted (documented in the spec).
export function fromClaudeEffort(effort: EffortLevel | null | undefined): ThinkingLevel {
  return effort ?? "off";
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @kermanych/api test -- effort-map`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/effort-map.ts apps/api/test/effort-map.spec.ts
git commit -m "feat(runtime): omp<->claude effort mapping"
```

---

## Task 4: SDK message → `RpcEvent` translation (pure)

**Files:**
- Create: `apps/api/src/runtime/claude-event-map.ts`
- Test: `apps/api/test/claude-event-map.spec.ts`

**Interfaces:**
- Consumes: `SDKMessage` from `@anthropic-ai/claude-agent-sdk` (type only); `RpcEvent` from `@kermanych/core`.
- Produces: `type ClaudeMapState`, `initClaudeMapState(): ClaudeMapState`, `mapSdkMessage(msg: SDKMessage, st: ClaudeMapState): RpcEvent[]`. The function mutates and returns `st` implicitly (carried between calls) and returns the events for this message.

**Translation rules (grounded in sdk.d.ts 0.3.258):**
- `system`/`init` → `[{ type: "ready", protocolVersion: 2 }]`.
- `stream_event` whose `event.type === "content_block_delta"` and `event.delta.type === "text_delta"` → open the turn if needed, then `message_update { assistantMessageEvent: { type: "text", delta } }`.
- `assistant` message content blocks: `tool_use` → `tool_execution_start { toolName, toolCallId: id, args: input }`. (Text is streamed via `stream_event`; do not re-emit it here. `thinking` blocks are deferred this increment.)
- `user` message content blocks: `tool_result` → `tool_execution_end { toolName, toolCallId: tool_use_id, isError: is_error, result: { content: [{ type: "text", text }] } }`. Tool name is recovered from the recorded call id.
- `result` → `message_end { message: { model, duration, usage } }` then `agent_end { isTerminal: true }`, and reset the turn.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/claude-event-map.spec.ts
import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initClaudeMapState, mapSdkMessage } from "../src/runtime/claude-event-map";
import type { RpcEvent } from "@kermanych/core";

function run(msgs: SDKMessage[]): RpcEvent[] {
  const st = initClaudeMapState();
  return msgs.flatMap((m) => mapSdkMessage(m, st));
}
const textDelta = (t: string): SDKMessage =>
  ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } } as unknown as SDKMessage);

describe("claude event map", () => {
  it("turns system/init into a ready frame", () => {
    expect(run([{ type: "system", subtype: "init" } as unknown as SDKMessage]))
      .toEqual([{ type: "ready", protocolVersion: 2 }]);
  });

  it("streams text deltas as message_update after a message_start", () => {
    const out = run([textDelta("Hel"), textDelta("lo")]);
    expect(out[0]).toEqual({ type: "message_start" });
    expect(out.slice(1)).toEqual([
      { type: "message_update", assistantMessageEvent: { type: "text", delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text", delta: "lo" } },
    ]);
  });

  it("pairs a tool_use with its tool_result by id", () => {
    const assistant = { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "tu_1", name: "read", input: { path: "a.ts" } },
    ] } } as unknown as SDKMessage;
    const user = { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false },
    ] } } as unknown as SDKMessage;
    const out = run([assistant, user]);
    expect(out).toContainEqual({ type: "tool_execution_start", toolName: "read", toolCallId: "tu_1", args: { path: "a.ts" } });
    expect(out).toContainEqual({ type: "tool_execution_end", toolName: "read", toolCallId: "tu_1", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
  });

  it("closes a turn on result with usage then agent_end", () => {
    const result = { type: "result", subtype: "success", duration_ms: 1200, modelUsage: {
      "claude-opus-4-8": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, costUSD: 0.5 },
    } } as unknown as SDKMessage;
    const out = run([result]);
    expect(out[0]).toEqual({ type: "message_end", message: {
      model: "claude-opus-4-8", duration: 1200,
      usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 1, cost: { total: 0.5 } },
    } });
    expect(out[1]).toEqual({ type: "agent_end", isTerminal: true });
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @kermanych/api test -- claude-event-map`
Expected: FAIL — cannot find `../src/runtime/claude-event-map`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/runtime/claude-event-map.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent } from "@kermanych/core";

// Carried across messages within one query() lifetime: whether an assistant turn has been
// opened (so a single message_start precedes the first delta), and the tool name recorded
// per tool_use id (claude's tool_result repeats only the id).
export interface ClaudeMapState {
  turnOpen: boolean;
  toolNames: Map<string, string>;
}
export function initClaudeMapState(): ClaudeMapState {
  return { turnOpen: false, toolNames: new Map() };
}

// Sum a result's per-model usage into the single accounting shape message_end carries.
function sumUsage(modelUsage: Record<string, {
  inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number;
}>): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    cacheRead += u.cacheReadInputTokens ?? 0;
    cacheWrite += u.cacheCreationInputTokens ?? 0;
    cost += u.costUSD ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function openTurn(st: ClaudeMapState, out: RpcEvent[]): void {
  if (!st.turnOpen) { st.turnOpen = true; out.push({ type: "message_start" }); }
}

export function mapSdkMessage(msg: SDKMessage, st: ClaudeMapState): RpcEvent[] {
  const out: RpcEvent[] = [];
  const m = msg as Record<string, unknown> & { type: string };

  if (m.type === "system") {
    if ((m as { subtype?: string }).subtype === "init") out.push({ type: "ready", protocolVersion: 2 });
    return out;
  }

  if (m.type === "stream_event") {
    const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      openTurn(st, out);
      out.push({ type: "message_update", assistantMessageEvent: { type: "text", delta: ev.delta.text } });
    }
    return out;
  }

  if (m.type === "assistant") {
    const content = ((m as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>;
    openTurn(st, out);
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === "tool_use") {
        const id = String(block.id ?? "");
        const name = String(block.name ?? "");
        st.toolNames.set(id, name);
        out.push({ type: "tool_execution_start", toolName: name, toolCallId: id, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return out;
  }

  if (m.type === "user") {
    const content = ((m as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === "tool_result") {
        const id = String(block.tool_use_id ?? "");
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        out.push({
          type: "tool_execution_end",
          toolName: st.toolNames.get(id) ?? "",
          toolCallId: id,
          isError: block.is_error === true,
          result: { content: [{ type: "text", text }] },
        });
      }
    }
    return out;
  }

  if (m.type === "result") {
    const r = m as { model?: string; duration_ms?: number; modelUsage?: Record<string, never> };
    const model = r.model ?? Object.keys(r.modelUsage ?? {})[0];
    out.push({ type: "message_end", message: {
      ...(model ? { model } : {}),
      ...(typeof r.duration_ms === "number" ? { duration: r.duration_ms } : {}),
      usage: sumUsage(r.modelUsage ?? {}),
    } });
    out.push({ type: "agent_end", isTerminal: true });
    st.turnOpen = false;
    return out;
  }

  return out; // other SDK message kinds are not surfaced this increment
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @kermanych/api test -- claude-event-map`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/claude-event-map.ts apps/api/test/claude-event-map.spec.ts
git commit -m "feat(runtime): translate claude SDK messages to RpcEvent"
```

---

## Task 5: `ClaudeCodeRuntime` adapter

**Files:**
- Create: `apps/api/src/runtime/claude-code-runtime.ts`
- Modify: `apps/api/src/runtime/agent-runtime.ts` (factory returns the adapter for `claude-code`)
- Test: `apps/api/test/claude-code-runtime.spec.ts`

**Interfaces:**
- Consumes: `RuntimeLaunchOpts`, `AgentRuntime`, `RpcStateData` (from `agent-runtime.ts`); `mapSdkMessage`/`initClaudeMapState` (Task 4); `toClaudeEffort`/`toClaudeThinking`/`fromClaudeEffort` (Task 3); `query`, `SDKMessage`, `SDKUserMessage`, `Query`, `Options` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `class ClaudeCodeRuntime implements AgentRuntime`, with an injectable `queryFn` (defaults to the SDK's `query`) so tests drive it without a live CLI.

**Design notes:**
- Streaming input via a pushable async generator (`InputQueue`): `prompt`/`followUp` enqueue an `SDKUserMessage`; `steer` calls `query.interrupt()` then enqueues.
- Tool autonomy: pass `canUseTool: async () => ({ behavior: "allow" })` so the agent runs without hanging on permission prompts (no UI to answer in this increment).
- Do NOT set `options.env` (the SDK REPLACES `process.env` when it is set); inherit the environment so `PATH`/auth flow through.
- `getState()` reads `query.getContextUsage()`/`initializationResult()` best-effort; `sessionId` is captured from the first `system/init`.
- `getAllMessages()` returns `[]` this increment (resume respawns and continues; transcript rehydrate from claude's session JSONL is validated in Task 7 and, if viable, implemented then — otherwise the documented fallback is persisting our own transcript, an Increment 4 item).
- `droppedFrames` is always `0` (no frame decoding).

- [ ] **Step 1: Write the failing test (fake SDK, no live CLI)**

```ts
// apps/api/test/claude-code-runtime.spec.ts
import { describe, it, expect, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code-runtime";
import type { RpcEvent } from "@kermanych/core";

// A fake Query: yields a scripted script, records interrupt(), and exposes the input iterable
// the runtime pushed into (so we can assert prompt/follow-up were enqueued).
function fakeQuery(script: SDKMessage[]) {
  const calls = { interrupts: 0, sent: [] as SDKUserMessage[], model: undefined as string | undefined };
  const queryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: unknown }) => {
    (async () => { for await (const m of params.prompt) calls.sent.push(m); })();
    const gen = (async function* () { for (const m of script) yield m; })() as AsyncGenerator<SDKMessage, void> & Record<string, unknown>;
    gen.interrupt = async () => { calls.interrupts++; return undefined; };
    gen.setModel = async (model?: string) => { calls.model = model; };
    gen.setPermissionMode = async () => {};
    gen.supportedModels = async () => [];
    gen.getContextUsage = async () => ({ percent: 42 });
    gen.initializationResult = async () => ({ session_id: "sess-1", model: "claude-opus-4-8" });
    return gen;
  };
  return { queryFn, calls };
}

describe("ClaudeCodeRuntime", () => {
  it("emits ready on init and forwards mapped events, then agent_end", async () => {
    const script: SDKMessage[] = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8" } as unknown as SDKMessage,
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } } as unknown as SDKMessage,
      { type: "result", subtype: "success", duration_ms: 5, modelUsage: {} } as unknown as SDKMessage,
    ];
    const { queryFn } = fakeQuery(script);
    const rt = new ClaudeCodeRuntime({ cwd: "/tmp/x" }, queryFn as never);
    const events: RpcEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.start();
    rt.prompt("do it");
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_end")).toBe(true));
    expect(events[0]).toEqual({ type: "ready", protocolVersion: 2 });
    expect(events).toContainEqual({ type: "message_update", assistantMessageEvent: { type: "text", delta: "hi" } });
  });

  it("steer interrupts then enqueues", async () => {
    const { queryFn, calls } = fakeQuery([{ type: "system", subtype: "init" } as unknown as SDKMessage]);
    const rt = new ClaudeCodeRuntime({ cwd: "/tmp/x" }, queryFn as never);
    rt.onEvent(() => {});
    await rt.start();
    rt.steer("stop, do this instead");
    await vi.waitFor(() => expect(calls.interrupts).toBe(1));
    await vi.waitFor(() => expect(calls.sent.some((m) => JSON.stringify(m).includes("stop, do this instead"))).toBe(true));
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @kermanych/api test -- claude-code-runtime`
Expected: FAIL — cannot find `../src/runtime/claude-code-runtime`.

- [ ] **Step 3: Implement the adapter**

```ts
// apps/api/src/runtime/claude-code-runtime.ts
import { query as sdkQuery, type SDKMessage, type SDKUserMessage, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel } from "@kermanych/core";
import type { AgentRuntime, RpcStateData, RuntimeLaunchOpts } from "./agent-runtime";
import { initClaudeMapState, mapSdkMessage, type ClaudeMapState } from "./claude-event-map";
import { toClaudeEffort, toClaudeThinking, fromClaudeEffort } from "./effort-map";

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

// A pushable async generator: the runtime feeds user turns into a live query() this way.
class InputQueue {
  private pending: SDKUserMessage[] = [];
  private waiter?: (m: IteratorResult<SDKUserMessage>) => void;
  private closed = false;
  push(m: SDKUserMessage): void {
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: m, done: false }); }
    else this.pending.push(m);
  }
  close(): void {
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: undefined as never, done: true }); }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.pending.length) { yield this.pending.shift()!; continue; }
      if (this.closed) return;
      yield await new Promise<SDKUserMessage>((resolve) => { this.waiter = (r) => resolve(r.value as SDKUserMessage); });
    }
  }
}

function userMessage(text: string, images?: ImageInput[]): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const img of images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as unknown as SDKUserMessage;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly droppedFrames = 0;
  private input = new InputQueue();
  private q?: Query;
  private mapState: ClaudeMapState = initClaudeMapState();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null, reason: string) => void)[] = [];
  private alive = false;
  private sessionId?: string;
  private model?: string;
  private thinking: ThinkingLevel;

  constructor(private opts: RuntimeLaunchOpts, private queryFn: QueryFn = sdkQuery) {
    this.thinking = opts.thinking ?? "off";
  }

  onEvent(cb: (e: RpcEvent) => void): void { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null, reason: string) => void): void { this.exitCbs.push(cb); }
  isAlive(): boolean { return this.alive; }

  private emit(e: RpcEvent): void { for (const cb of this.eventCbs) cb(e); }

  async start(): Promise<void> {
    const effort = toClaudeEffort(this.thinking);
    const options: Options = {
      cwd: this.opts.cwd,
      includePartialMessages: true,
      canUseTool: async () => ({ behavior: "allow" }),
      thinking: toClaudeThinking(this.thinking),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effort ? { effort } : {}),
      ...(this.opts.tools ? { allowedTools: this.opts.tools } : {}),
      ...(this.opts.noTools ? { tools: [] } : {}),
      ...(this.opts.fork ? { resume: this.opts.fork, forkSession: true } : {}),
    };
    const q = this.queryFn({ prompt: this.input, options });
    this.q = q;
    this.alive = true;
    const { promise: ready, resolve } = Promise.withResolvers<void>();
    // Drain the SDK stream in the background, translating each message to RpcEvent(s).
    (async () => {
      try {
        for await (const msg of q) {
          const m = msg as { type?: string; session_id?: string; model?: string };
          if (m.type === "system" && m.session_id) this.sessionId = m.session_id;
          if (m.type === "system" && m.model) this.model = m.model;
          for (const e of mapSdkMessage(msg, this.mapState)) {
            if (e.type === "ready") resolve();
            this.emit(e);
          }
        }
        this.alive = false;
        for (const cb of this.exitCbs) cb(0, "claude query ended");
      } catch (err) {
        this.alive = false;
        const reason = (err as Error).message ?? "claude query failed";
        this.emit({ type: "notice", level: "warn", message: reason });
        for (const cb of this.exitCbs) cb(null, reason);
      }
    })();
    await ready;
  }

  prompt(message: string, images?: ImageInput[]): void { this.input.push(userMessage(message, images)); }
  followUp(message: string, images?: ImageInput[]): void { this.input.push(userMessage(message, images)); }
  steer(message: string, images?: ImageInput[]): void {
    void this.q?.interrupt().catch(() => {});
    this.input.push(userMessage(message, images));
  }
  answerUi(_res: RpcExtensionUIResponse): void { /* interactive UI not surfaced this increment */ }

  async getState(): Promise<RpcStateData> {
    let percent: number | undefined;
    try { const cu = await this.q?.getContextUsage?.(); percent = (cu as { percent?: number } | undefined)?.percent; } catch { /* best effort */ }
    return {
      isStreaming: this.mapState.turnOpen,
      ...(percent !== undefined ? { contextUsage: { percent } } : {}),
      ...(this.model ? { model: { provider: "anthropic", id: this.model } } : {}),
      thinkingLevel: fromClaudeEffort(toClaudeEffort(this.thinking)),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  async switchSession(_sessionPath: string): Promise<void> {
    // Resume is expressed at start() via opts.fork/resume; a live switch is not used by the
    // claude path this increment. No-op keeps the supervisor's doResume shape intact.
  }
  async setModel(_provider: string, modelId: string): Promise<void> { this.model = modelId; await this.q?.setModel(modelId); }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.thinking = level;
    const effort = toClaudeEffort(level);
    // No dedicated live effort setter; approximate via thinking-token budget (coarse; see spec).
    await this.q?.setMaxThinkingTokens?.(effort ? null : 0);
  }
  async getAllMessages(): Promise<unknown[]> { return []; }

  async stop(): Promise<void> {
    try { await this.q?.interrupt().catch(() => {}); } finally { this.input.close(); this.alive = false; }
  }
}
```

- [ ] **Step 4: Wire the factory to the adapter**

In `apps/api/src/runtime/agent-runtime.ts`, replace the `claude-code` throw with the real construction, and add the import at the top of the file:

```ts
import { ClaudeCodeRuntime } from "./claude-code-runtime";
// …
export function createRuntime(kind: AgentRuntimeKind, opts: RuntimeLaunchOpts): AgentRuntime {
  if (kind === "omp") return new RpcSession(opts);
  return new ClaudeCodeRuntime(opts);
}
```

Update `apps/api/test/runtime-factory.spec.ts`'s second test: `createRuntime("claude-code", { cwd: "/tmp/x" })` now returns a runtime; assert it exposes the same `REQUIRED_METHODS` and `isAlive() === false` (replace the `toThrow` assertion).

- [ ] **Step 5: Run the adapter + factory tests**

Run: `pnpm --filter @kermanych/api test -- claude-code-runtime runtime-factory`
Expected: PASS (adapter: 2 tests; factory: 2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/runtime/claude-code-runtime.ts apps/api/src/runtime/agent-runtime.ts apps/api/test/claude-code-runtime.spec.ts apps/api/test/runtime-factory.spec.ts
git commit -m "feat(runtime): ClaudeCodeRuntime adapter over claude-agent-sdk"
```

---

## Task 6: install the SDK and route the supervisor through the factory

**Files:**
- Modify: `apps/api/package.json` (add dependency)
- Modify: `apps/api/src/supervisor/supervisor.service.ts` (`Live.rpc` type; `wireLive`; `launch` ≈557; `doResume` ≈1550; add `runtimeFor`)
- Test: existing `apps/api` suites (regression) + typecheck

**Interfaces:**
- Consumes: `createRuntime`, `AgentRuntime` (Task 2/5); `isAgentRuntime` (Task 1).
- Produces: `private runtimeFor(session?: Session): AgentRuntimeKind` (dev switch), `Live.rpc: AgentRuntime`.

- [ ] **Step 1: Add the SDK dependency**

Run: `pnpm --filter @kermanych/api add @anthropic-ai/claude-agent-sdk`
Then add `@anthropic-ai/claude-agent-sdk` to the `onlyBuiltDependencies` array in the ROOT `package.json` only if pnpm warns about an ignored build script for it. The `claude` CLI is a **separate** install (`@anthropic-ai/claude-code` or the platform binary) and is a runtime prerequisite, not bundled — note this, do not add it as a hard dep.

Expected: `apps/api/package.json` gains the dependency; `pnpm install` completes.

- [ ] **Step 2: Change the `Live` type and `wireLive` signature**

In `apps/api/src/supervisor/supervisor.service.ts`:
- Add import: `import { createRuntime, type AgentRuntime } from "../runtime/agent-runtime";` and `import { isAgentRuntime } from "@kermanych/core";` (add `AgentRuntimeKind` to the existing `@kermanych/core` type import).
- In `type Live` (line ~50), change `rpc: RpcSession;` to `rpc: AgentRuntime;`.
- Change `private wireLive(sessionId: string, rpc: RpcSession, status: Session["status"]): Live` (≈1512) to `rpc: AgentRuntime`.
- The existing `import { RpcSession } from "../rpc/rpc-session";` may now be unused — remove it only if no other reference remains.

- [ ] **Step 3: Add the dev-switch resolver**

Add a private method to `SupervisorService` (near `resolveLaunchParams`):

```ts
// Increment-1 dev switch: choose the backend from KERMANYCH_RUNTIME (default omp). Per-user
// preference + Session.runtime persistence arrive in Increment 2; until then the env var is
// the single selector and is read consistently at launch and at resume.
private runtimeFor(_session?: Session): AgentRuntimeKind {
  const v = process.env.KERMANYCH_RUNTIME;
  return isAgentRuntime(v) ? v : "omp";
}
```

- [ ] **Step 4: Route `launch` (agent) through the factory**

Replace the `new RpcSession({...})` at ≈557 with:

```ts
const rpc = createRuntime(this.runtimeFor(session), { cwd, model, ...(effort ? { thinking: effort } : {}), ...(fork ? { fork } : {}), ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
```

(The opts object is unchanged; only the constructor call becomes the factory. `configPath`/`extensionPath` are ignored by the claude adapter.)

- [ ] **Step 5: Route `doResume` through the factory**

Replace the `new RpcSession({...})` at ≈1550 with:

```ts
const rpc = createRuntime(this.runtimeFor(s), { cwd: dir, ...(s.kind === "chat" ? { tools: CHAT_TOOLS } : {}), ...(configPath ? { configPath } : {}), ...(extensionPath ? { extensionPath } : {}) });
```

Leave the `if (s.ompSessionFile) { await rpc.switchSession(s.ompSessionFile); this.rehydrate(...) }` block as-is: for claude `switchSession` is a no-op and `getAllMessages()` returns `[]` (empty rehydrate this increment), while omp behaves exactly as before.

- [ ] **Step 6: Typecheck and run the full api suite (regression)**

Run: `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/api test`
Expected: typecheck clean; all existing api tests still PASS (the omp path is behavior-identical because `KERMANYCH_RUNTIME` is unset in tests → `runtimeFor` returns `"omp"` → factory returns `RpcSession`), plus the new runtime suites PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src/supervisor/supervisor.service.ts ../pnpm-lock.yaml
git commit -m "feat(runtime): route supervisor launch/resume through the runtime factory (env dev switch)"
```

(Adjust the `pnpm-lock.yaml` path to the repo root if `git add` reports it outside the cwd.)

---

## Task 7: live smoke verification (manual) — the real proof

**Files:** none (verification only). Prerequisite: `claude` CLI installed and authenticated on the machine (`claude` on PATH; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` set). If it is not, this task is BLOCKED — report that rather than marking it done.

- [ ] **Step 1: Baseline the omp path is untouched**

Start the app with no env override and confirm an omp agent session still works exactly as before:
Run: `pnpm dev:app` (or `pnpm dev:api` + `pnpm dev:ui`). Create a task, run it, observe the transcript streams and the composer chips render. Expected: identical to `dev`.

- [ ] **Step 2: Launch an agent on claude-code**

Stop the app; relaunch with the switch:
Run: `KERMANYCH_RUNTIME=claude-code pnpm dev:app`
Create a task in a bound project and run it. Expected: the child starts; the transcript shows streamed assistant text and tool rows with the SAME shapes as omp (this exercises `claude-event-map` end-to-end).

- [ ] **Step 3: Exercise the loop**

In the running claude session: send a **follow-up** message (turn continues), then **steer** mid-turn (the current turn interrupts and the new instruction takes over), then **stop**. Expected: follow-up appends and answers; steer visibly interrupts; stop ends the child.

- [ ] **Step 4: Resume**

Reopen/resume the session (the composer ↻ / `resume`). Expected: the child respawns on the claude runtime and accepts new turns. **Risk area 3:** note whether the prior transcript rehydrates (it will be empty this increment — `getAllMessages()` returns `[]`). Record whether reading claude's session JSONL is viable for a follow-up, else confirm the "persist our own transcript" fallback for Increment 4.

- [ ] **Step 5: Validate the two remaining risk areas**

- **Risk area 1 (live effort):** change the effort chip mid-session; confirm it does not crash and takes effect on the next turn (coarser than omp is acceptable).
- **Risk area 2 (context% / todoPhases):** confirm the context chip shows a percentage (from `getContextUsage()`); note that `todoPhases` are not derived this increment (a documented Increment-3 item) and confirm their absence does not break the plan lane.

- [ ] **Step 6: Record findings**

Append a short "Increment 1 smoke results" note to the spec's §9 (or a sibling `docs/superpowers/plans/2026-09-03-claude-code-runtime-increment-1-findings.md`) capturing: what worked, the resume-rehydrate decision, and any SDK shape corrections discovered against the installed `sdk.d.ts`. Commit it.

```bash
git add docs/superpowers/plans/2026-09-03-claude-code-runtime-increment-1-findings.md
git commit -m "docs(runtime): increment 1 smoke findings"
```

---

## Self-review (author checklist — completed)

- **Spec coverage (Increment 1 slice):** AgentRuntime seam + RpcEvent contract (Tasks 2, 4) ✓; OmpRuntime = RpcSession implements (Task 2) ✓; ClaudeCodeRuntime via SDK (Task 5) ✓; factory over the launch+resume sites with a dev switch (Task 6) ✓; effort mapping (Task 3) ✓; three risk areas validated (Task 7) ✓. Deferred by design: fork (Increment 3), per-user data model + onboarding UI (Increment 2), skills-inline / management routing / usage / TTSR (Increments 3-4) — these are NOT in this slice and are called out in the SCOPE NOTE.
- **Placeholder scan:** no TBD/TODO; every code step carries real code; the one intentional stub (`getAllMessages() → []`) is documented with its follow-up path.
- **Type consistency:** `AgentRuntime` method names match `RpcSession` verbatim (`switchSession`, `setThinkingLevel`, `droppedFrames`); `createRuntime(kind, opts)` and `RuntimeLaunchOpts` are used identically in Tasks 2, 5, 6; `mapSdkMessage(msg, st)` / `initClaudeMapState()` signatures match between Tasks 4 and 5; the `message_end.message.usage` shape matches `packages/core/src/types.ts` (`{ input, output, cacheRead, cacheWrite, cost: { total } }`).
