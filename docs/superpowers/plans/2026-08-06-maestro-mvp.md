# Maestro MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that launches, groups, and visually supervises multiple `omp` coding-agent sessions, one git worktree + one `omp --mode rpc` process per session.

**Architecture:** A Bun/TypeScript backend spawns one `omp --mode rpc` child per session, normalizes its JSONL event stream into a `SessionStatus`, and pushes deltas to a React browser UI over WebSocket. Groups map to git repos; sessions map to worktrees. omp owns all agent intelligence and transcript persistence; Maestro is the orchestration shell.

**Tech Stack:** Bun (runtime, `Bun.spawn`, `Bun.serve`, `bun:sqlite`), TypeScript (strict), React + Vite + Tailwind, Zustand (UI store). External binary: `omp` (RPC protocol per `omp://rpc.md`).

## Global Constraints

- Bun ≥ 1.3.14; TypeScript `strict: true`.
- `omp` ≥ 17.2.9 on PATH; each session runs `omp --mode rpc --cwd <worktree> [--model <m>]`.
- RPC wire protocol per `omp://rpc.md`: read a `ready` frame first, then send `{ id, type: "negotiate_protocol", protocolVersion: 2 }`; correlate responses by `id`; reassemble `rpc_chunk` frames.
- Command acceptance ≠ completion. A turn is done only on `agent_end` with `isTerminal !== false`.
- Worktrees live under `~/.maestro/worktrees/<sessionId>`; branches named `maestro/<slug>`. Registry DB at `~/.maestro/maestro.sqlite`.
- Testing: TDD (failing test first) for **pure logic only** — `reduceStatus`, worktree naming, frame/line decoding, registry queries. Integration (RpcSession, supervisor, server, UI) is verified by **smoke test**, never by mock-heavy unit tests. Do not test plumbing.
- One commit per task. Conventional-commit messages.

---

## File Structure

```
maestro/
  package.json              # Bun scripts + deps
  tsconfig.json             # strict TS
  src/
    server/
      types.ts              # shared domain + wire types (Group, Session, SessionStatus, ServerEvent, RpcEvent, ...)
      rpc-frames.ts         # line splitter + v2 chunk reassembler (pure)
      rpc-session.ts        # one omp --mode rpc child: spawn, ready, negotiate, prompt, typed events
      status.ts             # reduceStatus(state, event) -> StatusState (pure)
      worktree.ts           # slugify/branchName/uniqueSlug (pure) + add/remove (git exec)
      registry.ts           # bun:sqlite groups/sessions persistence
      supervisor.ts         # owns RpcSessions, applies status, buffers transcript, emits ServerEvents
      server.ts             # Bun.serve: REST + WebSocket; wires supervisor
      spike.ts              # Task 1 throwaway: drive one omp --mode rpc and print events
  web/
    index.html
    vite.config.ts
    src/
      main.tsx
      store.ts              # zustand store + REST calls + WS client
      api.ts                # typed REST helpers
      App.tsx
      components/
        Sidebar.tsx
        SessionBoard.tsx
        SessionCard.tsx
        NewSessionForm.tsx
        SessionDetail.tsx
        UiRequestWidget.tsx
  tests/
    rpc-frames.test.ts
    status.test.ts
    worktree.test.ts
    registry.test.ts
```

---

### Task 1: Scaffold + RPC spike (grounding)

**Files:**
- Create: `maestro/package.json`, `maestro/tsconfig.json`, `maestro/src/server/spike.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: proof that `omp --mode rpc` behaves as documented; the observed event/`extension_ui_request` shapes inform Tasks 2–3. No exported code.

- [ ] **Step 1: package.json**

```json
{
  "name": "maestro",
  "private": true,
  "type": "module",
  "scripts": {
    "spike": "bun src/server/spike.ts",
    "server": "bun src/server/server.ts",
    "test": "bun test",
    "web": "vite web"
  },
  "devDependencies": { "typescript": "^5.6.0", "@types/react": "^18", "@types/react-dom": "^18", "vite": "^5", "@vitejs/plugin-react": "^4" },
  "dependencies": { "react": "^18", "react-dom": "^18", "zustand": "^4" }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "jsx": "react-jsx",
    "types": ["bun-types"], "lib": ["ESNext", "DOM"]
  }
}
```

- [ ] **Step 3: Write the spike**

```ts
// src/server/spike.ts
const proc = Bun.spawn(["omp", "--mode", "rpc", "--cwd", process.cwd()], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const enc = new TextEncoder();
const send = (o: unknown) => proc.stdin.write(enc.encode(JSON.stringify(o) + "\n"));

let buf = "";
const reader = proc.stdout.getReader();
const dec = new TextDecoder();
let sentPrompt = false;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    console.log("<<", frame.type, JSON.stringify(frame).slice(0, 200));
    if (frame.type === "ready" && !sentPrompt) {
      send({ id: "n1", type: "negotiate_protocol", protocolVersion: 2 });
      send({ id: "p1", type: "prompt", message: "List the top-level files, then stop." });
      sentPrompt = true;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      send({ id: "s1", type: "get_state" });
    }
    if (frame.command === "get_state") { proc.stdin.end(); }
  }
}
```

- [ ] **Step 4: Run the spike**

Run: `cd maestro && bun run spike`
Expected: a `ready` frame, then `agent_start` / `message_update` / `tool_execution_start` / `agent_end`, then a `get_state` response containing `isStreaming`, `contextUsage`, `todoPhases`. Record the exact `extension_ui_request` shape if one appears. If startup fails for missing auth/model, resolve omp auth first — Maestro requires an authenticated omp.

- [ ] **Step 5: Commit**

```bash
git add maestro/package.json maestro/tsconfig.json maestro/src/server/spike.ts
git commit -m "chore: scaffold maestro + omp rpc spike"
```

---

### Task 2: RPC frame decoding (pure)

**Files:**
- Create: `maestro/src/server/types.ts`, `maestro/src/server/rpc-frames.ts`, `maestro/tests/rpc-frames.test.ts`

**Interfaces:**
- Produces:
  - `type RpcEvent` union and `RpcExtensionUIRequest`/`RpcExtensionUIResponse` (in `types.ts`).
  - `class LineSplitter { push(chunk: string): string[] }` — buffers text, returns complete lines.
  - `class ChunkReassembler { push(frame: any): any | null }` — returns a reassembled JSON object when a `rpc_chunk` sequence completes, passes through non-chunk frames, throws on interleaved/interrupted sequences.

- [ ] **Step 1: Define wire + domain types**

```ts
// src/server/types.ts
export type SessionStatus =
  | "queued" | "thinking" | "tool" | "waiting_input" | "done" | "error" | "stopped";

export type TodoTask = { id: string; content: string; status: "pending" | "in_progress" | "completed" | string };
export type TodoPhase = { id: string; name: string; tasks: TodoTask[] };

export type Group = { id: string; name: string; projectDir: string; createdAt: string };

export type Session = {
  id: string; groupId: string; name: string; task: string;
  worktreePath: string; branch: string;
  ompSessionId?: string; ompSessionFile?: string;
  status: SessionStatus; currentTool?: string;
  todoPhases?: TodoPhase[]; contextPercent?: number;
  pendingUiRequest?: RpcExtensionUIRequest; createdAt: string;
};

export type TranscriptEntry =
  | { kind: "assistant_text"; text: string }
  | { kind: "assistant_thinking"; text: string }
  | { kind: "tool_call"; tool: string; summary?: string }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
  | { kind: "notice"; text: string };

export type RpcExtensionUIRequest = {
  type: "extension_ui_request"; id: string;
  method: "select" | "confirm" | "input" | "editor" | "cancel" | "notify" | string;
  title?: string; message?: string; placeholder?: string; options?: string[]; timeout?: number;
};
export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcEvent =
  | { type: "ready"; protocolVersion: number; supportedProtocolVersions?: number[] }
  | { type: "response"; id?: string; command: string; success: boolean; data?: any; error?: string }
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start" }
  | { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
  | { type: "message_end"; message?: any }
  | { type: "tool_execution_start"; toolName?: string; toolCallId?: string; args?: any }
  | { type: "tool_execution_end"; toolName?: string; isError?: boolean }
  | { type: "agent_end"; isTerminal?: boolean }
  | { type: "notice"; message?: string }
  | RpcExtensionUIRequest
  | { type: "rpc_chunk"; chunkId: string; index: number; count: number; byteLength: number; data: string }
  | { type: string; [k: string]: unknown };

// Server -> client WebSocket messages
export type ServerEvent =
  | { type: "snapshot"; groups: Group[]; sessions: Session[] }
  | { type: "session_update"; session: Session }
  | { type: "transcript_append"; sessionId: string; entry: TranscriptEntry }
  | { type: "group_update"; group: Group }
  | { type: "session_removed"; sessionId: string }
  | { type: "group_removed"; groupId: string };
```

- [ ] **Step 2: Write failing tests**

```ts
// tests/rpc-frames.test.ts
import { expect, test } from "bun:test";
import { LineSplitter, ChunkReassembler } from "../src/server/rpc-frames";

test("LineSplitter splits on newline and buffers partials", () => {
  const s = new LineSplitter();
  expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
  expect(s.push('2}\n')).toEqual(['{"b":2}']);
});

test("ChunkReassembler passes through non-chunk frames", () => {
  const r = new ChunkReassembler();
  expect(r.push({ type: "agent_start" })).toEqual({ type: "agent_start" });
});

test("ChunkReassembler reassembles independently-base64'd byte segments", () => {
  const r = new ChunkReassembler();
  const obj = { type: "response", command: "get_messages", data: { big: "x".repeat(20) } };
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  const seg = Math.ceil(bytes.length / 2);
  const c0 = bytes.subarray(0, seg).toString("base64");
  const c1 = bytes.subarray(seg).toString("base64");
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: bytes.length, data: c0 })).toBeNull();
  expect(r.push({ type: "rpc_chunk", chunkId: "c1", index: 1, count: 2, byteLength: bytes.length, data: c1 })).toEqual(obj);
});

test("ChunkReassembler handles multi-byte UTF-8 across a byte-split boundary", () => {
  const r = new ChunkReassembler();
  const obj = { type: "notice", message: "café ☕ 日本語 " + "y".repeat(8) };
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  const seg = Math.ceil(bytes.length / 2);
  expect(r.push({ type: "rpc_chunk", chunkId: "c9", index: 0, count: 2, byteLength: bytes.length, data: bytes.subarray(0, seg).toString("base64") })).toBeNull();
  expect(r.push({ type: "rpc_chunk", chunkId: "c9", index: 1, count: 2, byteLength: bytes.length, data: bytes.subarray(seg).toString("base64") })).toEqual(obj);
});

test("ChunkReassembler rejects interleaved sequences", () => {
  const r = new ChunkReassembler();
  r.push({ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: 10, data: "AA" });
  expect(() => r.push({ type: "rpc_chunk", chunkId: "c2", index: 0, count: 2, byteLength: 10, data: "BB" })).toThrow();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd maestro && bun test tests/rpc-frames.test.ts`
Expected: FAIL (module not found / not implemented).

- [ ] **Step 4: Implement**

```ts
// src/server/rpc-frames.ts
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) out.push(line);
    }
    return out;
  }
}

export class ChunkReassembler {
  private id: string | null = null;
  private parts: string[] = [];
  private count = 0;
  private byteLength = 0;
  push(frame: any): any | null {
    if (!frame || frame.type !== "rpc_chunk") {
      if (this.id !== null) throw new Error("non-chunk frame interleaved into chunk sequence");
      return frame;
    }
    if (this.id === null) { this.id = frame.chunkId; this.count = frame.count; this.byteLength = frame.byteLength; this.parts = new Array(frame.count).fill(""); }
    if (frame.chunkId !== this.id) throw new Error("interleaved chunk sequence");
    this.parts[frame.index] = frame.data;
    if (frame.index < this.count - 1) return null;
    const buf = Buffer.concat(this.parts.map((p) => Buffer.from(p, "base64")));
    if (buf.length !== this.byteLength) throw new Error("chunk byteLength mismatch");
    this.id = null; this.parts = []; this.count = 0;
    return JSON.parse(buf.toString("utf8"));
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd maestro && bun test tests/rpc-frames.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add maestro/src/server/types.ts maestro/src/server/rpc-frames.ts maestro/tests/rpc-frames.test.ts
git commit -m "feat: rpc wire types + frame decoding"
```

---

### Task 3: RpcSession wrapper

**Files:**
- Create: `maestro/src/server/rpc-session.ts`

**Interfaces:**
- Consumes: `LineSplitter`, `ChunkReassembler`, `RpcEvent`, `RpcExtensionUIResponse` (Task 2).
- Produces:
  ```ts
  export interface RpcStateData { isStreaming: boolean; contextUsage?: { percent: number }; model?: { provider: string; id: string }; sessionId?: string; sessionFile?: string; todoPhases?: TodoPhase[] }
  export class RpcSession {
    constructor(opts: { cwd: string; model?: string; ompPath?: string });
    onEvent(cb: (e: RpcEvent) => void): void;
    onExit(cb: (code: number | null) => void): void;
    start(): Promise<void>;                 // spawn, await ready, negotiate v2
    prompt(message: string): void;
    followUp(message: string): void;
    steer(message: string): void;
    answerUi(res: RpcExtensionUIResponse): void;
    getState(): Promise<RpcStateData>;
    stop(): Promise<void>;                  // close stdin, await exit
  }
  ```

- [ ] **Step 1: Implement RpcSession**

```ts
// src/server/rpc-session.ts
import { LineSplitter, ChunkReassembler } from "./rpc-frames";
import type { RpcEvent, RpcExtensionUIResponse, TodoPhase } from "./types";

export interface RpcStateData {
  isStreaming: boolean; contextUsage?: { percent: number };
  model?: { provider: string; id: string }; sessionId?: string; sessionFile?: string; todoPhases?: TodoPhase[];
}

export class RpcSession {
  private proc?: ReturnType<typeof Bun.spawn>;
  private enc = new TextEncoder();
  private splitter = new LineSplitter();
  private reassembler = new ChunkReassembler();
  private eventCbs: ((e: RpcEvent) => void)[] = [];
  private exitCbs: ((code: number | null) => void)[] = [];
  private pending = new Map<string, (r: any) => void>();
  private seq = 0;
  constructor(private opts: { cwd: string; model?: string; ompPath?: string }) {}

  onEvent(cb: (e: RpcEvent) => void) { this.eventCbs.push(cb); }
  onExit(cb: (code: number | null) => void) { this.exitCbs.push(cb); }

  private write(o: unknown) { this.proc!.stdin.write(this.enc.encode(JSON.stringify(o) + "\n")); }

  async start(): Promise<void> {
    const argv = ["omp", "--mode", "rpc", "--cwd", this.opts.cwd];
    if (this.opts.model) argv.push("--model", this.opts.model);
    if (this.opts.ompPath) argv[0] = this.opts.ompPath;
    this.proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc.exited.then((code) => this.exitCbs.forEach((cb) => cb(code)));
    const ready = new Promise<void>((resolve) => {
      const off = (e: RpcEvent) => { if (e.type === "ready") { this.write({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 }); resolve(); } };
      this.eventCbs.push(off);
    });
    this.readLoop();
    await ready;
  }

  private async readLoop() {
    const reader = this.proc!.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of this.splitter.push(dec.decode(value, { stream: true }))) {
        let frame: any;
        try { frame = JSON.parse(line); } catch { continue; }
        let obj: any;
        try { obj = this.reassembler.push(frame); } catch { continue; }
        if (obj === null) continue;
        if (obj.type === "response" && obj.id && this.pending.has(obj.id)) { this.pending.get(obj.id)!(obj); this.pending.delete(obj.id); }
        this.eventCbs.forEach((cb) => cb(obj as RpcEvent));
      }
    }
  }

  private command(type: string, extra: Record<string, unknown> = {}): Promise<any> {
    const id = `req_${++this.seq}`;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.write({ id, type, ...extra }); });
  }

  prompt(message: string) { this.write({ id: `req_${++this.seq}`, type: "prompt", message }); }
  followUp(message: string) { this.write({ id: `req_${++this.seq}`, type: "follow_up", message }); }
  steer(message: string) { this.write({ id: `req_${++this.seq}`, type: "steer", message }); }
  answerUi(res: RpcExtensionUIResponse) { this.write(res); }

  async getState(): Promise<RpcStateData> {
    const r = await this.command("get_state");
    return (r.data ?? {}) as RpcStateData;
  }

  async stop(): Promise<void> { try { this.proc?.stdin.end(); } catch {} await this.proc?.exited; }
}
```

- [ ] **Step 2: Smoke-verify against the spike target**

Temporarily add to `spike.ts` an alternate path (or a scratch script) that constructs `new RpcSession({ cwd: process.cwd() })`, `start()`s, `prompt("say hi and stop")`, logs events, and after `agent_end` calls `getState()` then `stop()`.
Run: `cd maestro && bun run spike`
Expected: same event stream as Task 1, plus a resolved `getState()` object with `contextUsage.percent`. Remove the scratch code after verifying.

- [ ] **Step 3: Commit**

```bash
git add maestro/src/server/rpc-session.ts
git commit -m "feat: RpcSession wrapper over omp --mode rpc"
```

---

### Task 4: Event → status reducer (pure, TDD)

**Files:**
- Create: `maestro/src/server/status.ts`, `maestro/tests/status.test.ts`

**Interfaces:**
- Consumes: `RpcEvent`, `SessionStatus` (Task 2).
- Produces:
  ```ts
  export type StatusState = { status: SessionStatus; currentTool?: string; prior?: SessionStatus };
  export const INITIAL_STATUS: StatusState;
  export function reduceStatus(s: StatusState, e: RpcEvent): StatusState;
  ```

- [ ] **Step 1: Write failing tests**

```ts
// tests/status.test.ts
import { expect, test } from "bun:test";
import { INITIAL_STATUS, reduceStatus } from "../src/server/status";

test("agent_start -> thinking", () => {
  expect(reduceStatus(INITIAL_STATUS, { type: "agent_start" } as any).status).toBe("thinking");
});
test("tool start/end toggles tool then thinking", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as any);
  s = reduceStatus(s, { type: "tool_execution_start", toolName: "read" } as any);
  expect(s.status).toBe("tool"); expect(s.currentTool).toBe("read");
  s = reduceStatus(s, { type: "tool_execution_end", toolName: "read" } as any);
  expect(s.status).toBe("thinking"); expect(s.currentTool).toBeUndefined();
});
test("ui request -> waiting_input and remembers prior", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as any);
  s = reduceStatus(s, { type: "extension_ui_request", id: "u1", method: "confirm" } as any);
  expect(s.status).toBe("waiting_input"); expect(s.prior).toBe("thinking");
});
test("non-interactive ui request (setWidget) does not change status", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as any);
  expect(reduceStatus(s, { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "x" } as any).status).toBe("thinking");
});
test("terminal agent_end -> done, non-terminal ignored", () => {
  let s = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as any);
  expect(reduceStatus(s, { type: "agent_end", isTerminal: false } as any).status).toBe("thinking");
  expect(reduceStatus(s, { type: "agent_end", isTerminal: true } as any).status).toBe("done");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd maestro && bun test tests/status.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/status.ts
import type { RpcEvent, SessionStatus } from "./types";
export type StatusState = { status: SessionStatus; currentTool?: string; prior?: SessionStatus };
export const INITIAL_STATUS: StatusState = { status: "queued" };
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function reduceStatus(s: StatusState, e: RpcEvent): StatusState {
  switch (e.type) {
    case "agent_start": case "turn_start": case "message_start":
    case "message_update": case "message_end":
      return { status: "thinking" };
    case "tool_execution_start":
      return { status: "tool", currentTool: (e as any).toolName };
    case "tool_execution_end":
      return { status: "thinking" };
    case "extension_ui_request":
      return INTERACTIVE_UI_METHODS.has((e as any).method)
        ? { status: "waiting_input", prior: s.status === "waiting_input" ? s.prior : s.status }
        : s;
    case "agent_end":
      return (e as any).isTerminal === false ? s : { status: "done" };
    default:
      return s;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd maestro && bun test tests/status.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add maestro/src/server/status.ts maestro/tests/status.test.ts
git commit -m "feat: event->status reducer"
```

---

### Task 5: Worktree manager (naming pure/TDD + git exec)

**Files:**
- Create: `maestro/src/server/worktree.ts`, `maestro/tests/worktree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function slugify(name: string): string;
  export function branchName(slug: string): string;              // `maestro/${slug}`
  export function uniqueSlug(base: string, existing: Set<string>): string;
  export function worktreeDir(sessionId: string): string;        // ~/.maestro/worktrees/<id>
  export async function addWorktree(repoDir: string, wtDir: string, branch: string): Promise<void>;
  export async function removeWorktree(repoDir: string, wtDir: string): Promise<void>;
  export async function isGitRepo(dir: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write failing tests (pure helpers only)**

```ts
// tests/worktree.test.ts
import { expect, test } from "bun:test";
import { slugify, branchName, uniqueSlug } from "../src/server/worktree";
test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("branchName prefixes maestro/", () => {
  expect(branchName("fix-login")).toBe("maestro/fix-login");
});
test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("fix", new Set(["fix", "fix-2"]))).toBe("fix-3");
  expect(uniqueSlug("fix", new Set())).toBe("fix");
});
```

- [ ] **Step 2: Run to verify fail** — `cd maestro && bun test tests/worktree.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/worktree.ts
import { homedir } from "os";
import { join } from "path";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}
export function branchName(slug: string): string { return `maestro/${slug}`; }
export function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2; while (existing.has(`${base}-${n}`)) n++; return `${base}-${n}`;
}
export function worktreeDir(sessionId: string): string {
  return join(homedir(), ".maestro", "worktrees", sessionId);
}
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  return { ok: code === 0, out: out + err };
}
export async function isGitRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}
export async function addWorktree(repoDir: string, wtDir: string, branch: string): Promise<void> {
  const r = await git(repoDir, ["worktree", "add", wtDir, "-b", branch]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.out}`);
}
export async function removeWorktree(repoDir: string, wtDir: string): Promise<void> {
  await git(repoDir, ["worktree", "remove", "--force", wtDir]);
}
```

- [ ] **Step 4: Run to verify pass** — `cd maestro && bun test tests/worktree.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add maestro/src/server/worktree.ts maestro/tests/worktree.test.ts
git commit -m "feat: worktree naming + git worktree ops"
```

---

### Task 6: Registry (bun:sqlite)

**Files:**
- Create: `maestro/src/server/registry.ts`, `maestro/tests/registry.test.ts`

**Interfaces:**
- Consumes: `Group`, `Session`, `SessionStatus` (Task 2).
- Produces:
  ```ts
  export class Registry {
    constructor(path: string);                          // ":memory:" in tests
    listGroups(): Group[];
    createGroup(g: Omit<Group, "id" | "createdAt">): Group;
    removeGroup(id: string): void;
    listSessions(groupId?: string): Session[];
    createSession(s: Omit<Session, "id" | "createdAt" | "status"> & { status?: SessionStatus }): Session;
    updateSession(id: string, patch: Partial<Session>): Session;
    removeSession(id: string): void;
  }
  ```
  Persisted columns: durable identity/config only (`id, group_id, name, task, worktree_path, branch, omp_session_id, omp_session_file, status, created_at`). Transient live fields (`currentTool`, `todoPhases`, `contextPercent`, `pendingUiRequest`) are held by the supervisor in memory and merged on read, not stored.

- [ ] **Step 1: Write failing tests**

```ts
// tests/registry.test.ts
import { expect, test } from "bun:test";
import { Registry } from "../src/server/registry";
test("group + session round trip", () => {
  const r = new Registry(":memory:");
  const g = r.createGroup({ name: "app", projectDir: "/tmp/app" });
  expect(r.listGroups()).toHaveLength(1);
  const s = r.createSession({ groupId: g.id, name: "task", task: "do it", worktreePath: "/wt", branch: "maestro/task" });
  expect(s.status).toBe("queued");
  const u = r.updateSession(s.id, { status: "done", contextPercent: 12 });
  expect(u.status).toBe("done");
  expect(r.listSessions(g.id)).toHaveLength(1);
  r.removeSession(s.id);
  expect(r.listSessions(g.id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify fail** — `cd maestro && bun test tests/registry.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/registry.ts
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { Group, Session, SessionStatus } from "./types";

export class Registry {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, project_dir TEXT, created_at TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, group_id TEXT, name TEXT, task TEXT, worktree_path TEXT, branch TEXT, omp_session_id TEXT, omp_session_file TEXT, status TEXT, created_at TEXT)`);
  }
  listGroups(): Group[] {
    return this.db.query(`SELECT id, name, project_dir as projectDir, created_at as createdAt FROM groups ORDER BY created_at`).all() as Group[];
  }
  createGroup(g: Omit<Group, "id" | "createdAt">): Group {
    const row: Group = { id: randomUUID(), createdAt: new Date().toISOString(), ...g };
    this.db.run(`INSERT INTO groups (id, name, project_dir, created_at) VALUES (?,?,?,?)`, [row.id, row.name, row.projectDir, row.createdAt]);
    return row;
  }
  removeGroup(id: string): void {
    this.db.run(`DELETE FROM sessions WHERE group_id = ?`, [id]);
    this.db.run(`DELETE FROM groups WHERE id = ?`, [id]);
  }
  listSessions(groupId?: string): Session[] {
    const sql = `SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, created_at as createdAt FROM sessions`;
    return (groupId ? this.db.query(sql + ` WHERE group_id = ? ORDER BY created_at`).all(groupId) : this.db.query(sql + ` ORDER BY created_at`).all()) as Session[];
  }
  createSession(s: Omit<Session, "id" | "createdAt" | "status"> & { status?: SessionStatus }): Session {
    const row: Session = { id: randomUUID(), createdAt: new Date().toISOString(), status: s.status ?? "queued", ...s } as Session;
    this.db.run(`INSERT INTO sessions (id, group_id, name, task, worktree_path, branch, omp_session_id, omp_session_file, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.id, row.groupId, row.name, row.task, row.worktreePath, row.branch, row.ompSessionId ?? null, row.ompSessionFile ?? null, row.status, row.createdAt]);
    return row;
  }
  updateSession(id: string, patch: Partial<Session>): Session {
    const cur = (this.db.query(`SELECT id, group_id as groupId, name, task, worktree_path as worktreePath, branch, omp_session_id as ompSessionId, omp_session_file as ompSessionFile, status, created_at as createdAt FROM sessions WHERE id = ?`).get(id)) as Session;
    const next = { ...cur, ...patch };
    this.db.run(`UPDATE sessions SET name=?, task=?, worktree_path=?, branch=?, omp_session_id=?, omp_session_file=?, status=? WHERE id=?`,
      [next.name, next.task, next.worktreePath, next.branch, next.ompSessionId ?? null, next.ompSessionFile ?? null, next.status, id]);
    return next;
  }
  removeSession(id: string): void { this.db.run(`DELETE FROM sessions WHERE id = ?`, [id]); }
}
```

- [ ] **Step 4: Run to verify pass** — `cd maestro && bun test tests/registry.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add maestro/src/server/registry.ts maestro/tests/registry.test.ts
git commit -m "feat: sqlite registry for groups + sessions"
```

---

### Task 7: Supervisor

**Files:**
- Create: `maestro/src/server/supervisor.ts`

**Interfaces:**
- Consumes: `RpcSession` (3), `reduceStatus`/`INITIAL_STATUS` (4), worktree ops (5), `Registry` (6), types (2).
- Produces:
  ```ts
  export class Supervisor {
    constructor(registry: Registry);
    onServerEvent(cb: (e: ServerEvent) => void): void;
    snapshot(): { groups: Group[]; sessions: Session[] };
    addGroup(name: string, projectDir: string): Promise<Group>;
    removeGroup(id: string): void;
    createSession(groupId: string, name: string, task: string, model?: string): Promise<Session>;
    sendMessage(sessionId: string, text: string, mode: "prompt" | "follow_up" | "steer"): void;
    answerUi(sessionId: string, res: RpcExtensionUIResponse): void;
    stopSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    getTranscript(sessionId: string): TranscriptEntry[];
  }
  ```
  Behavior: holds a `Map<sessionId, { rpc: RpcSession; state: StatusState; transcript: TranscriptEntry[]; live: Partial<Session>; textBuf: string }>`. On each RpcEvent: run `reduceStatus`; on `message_end` flush accumulated `assistant_text`; on `tool_execution_start/end` append transcript entries; on `extension_ui_request` set `pendingUiRequest`; poll `getState()` after `agent_end` and every ~2s while `thinking`/`tool` to refresh `todoPhases`/`contextPercent`. Emit a `session_update` (merged persisted+live Session) on every change and `transcript_append` per new entry.

- [ ] **Step 1: Implement supervisor**

```ts
// src/server/supervisor.ts
import { Registry } from "./registry";
import { RpcSession } from "./rpc-session";
import { INITIAL_STATUS, reduceStatus, type StatusState } from "./status";
import * as wt from "./worktree";
import { slugify, branchName, uniqueSlug, worktreeDir } from "./worktree";
import type { Group, RpcEvent, RpcExtensionUIResponse, ServerEvent, Session, TranscriptEntry } from "./types";

type Live = { rpc: RpcSession; state: StatusState; transcript: TranscriptEntry[]; live: Partial<Session>; textBuf: string; poll?: Timer };

export class Supervisor {
  private map = new Map<string, Live>();
  private cbs: ((e: ServerEvent) => void)[] = [];
  constructor(private registry: Registry) {}
  onServerEvent(cb: (e: ServerEvent) => void) { this.cbs.push(cb); }
  private emit(e: ServerEvent) { this.cbs.forEach((cb) => cb(e)); }
  snapshot() { return { groups: this.registry.listGroups(), sessions: this.registry.listSessions().map((s) => this.merge(s)) }; }

  private merge(s: Session): Session { const l = this.map.get(s.id)?.live ?? {}; return { ...s, ...l, status: (l.status as any) ?? s.status }; }
  private pushUpdate(id: string) { const s = this.registry.listSessions().find((x) => x.id === id); if (s) this.emit({ type: "session_update", session: this.merge(s) }); }

  async addGroup(name: string, projectDir: string): Promise<Group> {
    if (!(await wt.isGitRepo(projectDir))) throw new Error("project dir is not a git repo");
    const g = this.registry.createGroup({ name, projectDir }); this.emit({ type: "group_update", group: g }); return g;
  }
  removeGroup(id: string) { this.registry.removeGroup(id); this.emit({ type: "group_removed", groupId: id }); }

  async createSession(groupId: string, name: string, task: string, model?: string): Promise<Session> {
    const group = this.registry.listGroups().find((g) => g.id === groupId);
    if (!group) throw new Error("group not found");
    const existing = new Set(this.registry.listSessions(groupId).map((s) => s.branch.replace("maestro/", "")));
    const slug = uniqueSlug(slugify(name), existing);
    const branch = branchName(slug);
    const session = this.registry.createSession({ groupId, name, task, worktreePath: "", branch });
    const wtDir = worktreeDir(session.id);
    await wt.addWorktree(group.projectDir, wtDir, branch);
    const saved = this.registry.updateSession(session.id, { worktreePath: wtDir });
    const rpc = new RpcSession({ cwd: wtDir, model });
    const live: Live = { rpc, state: INITIAL_STATUS, transcript: [], live: { status: "queued" }, textBuf: "" };
    this.map.set(session.id, live);
    rpc.onExit((code) => { if (code && code !== 0 && live.live.status !== "stopped") { live.live.status = "error"; this.registry.updateSession(session.id, { status: "error" }); this.pushUpdate(session.id); } });
    rpc.onEvent((e) => this.onRpcEvent(session.id, e));
    await rpc.start();
    rpc.prompt(task);
    this.pushUpdate(session.id);
    return this.merge(saved);
  }

  private appendEntry(id: string, entry: TranscriptEntry) { const l = this.map.get(id)!; l.transcript.push(entry); this.emit({ type: "transcript_append", sessionId: id, entry }); }

  private onRpcEvent(id: string, e: RpcEvent) {
    const l = this.map.get(id); if (!l) return;
    const before = l.state.status;
    l.state = reduceStatus(l.state, e);
    if (e.type === "message_update" && (e as any).assistantMessageEvent?.type === "text_delta") l.textBuf += (e as any).assistantMessageEvent.delta ?? "";
    if (e.type === "message_end") { if (l.textBuf.trim()) this.appendEntry(id, { kind: "assistant_text", text: l.textBuf }); l.textBuf = ""; }
    if (e.type === "tool_execution_start") this.appendEntry(id, { kind: "tool_call", tool: (e as any).toolName ?? "?", summary: (e as any).args?.command ?? (e as any).args?.path });
    if (e.type === "tool_execution_end") this.appendEntry(id, { kind: "tool_result", tool: (e as any).toolName ?? "?", ok: !(e as any).isError });
    if (e.type === "extension_ui_request" && l.state.status === "waiting_input") l.live.pendingUiRequest = e as any;
    l.live.status = l.state.status; l.live.currentTool = l.state.currentTool;
    if (l.state.status !== "waiting_input") l.live.pendingUiRequest = undefined;
    if (e.type === "agent_end" && (e as any).isTerminal !== false) { this.registry.updateSession(id, { status: "done" }); this.refreshState(id); this.stopPoll(l); }
    if ((l.state.status === "thinking" || l.state.status === "tool") && !l.poll) l.poll = setInterval(() => this.refreshState(id), 2000);
    if (before !== l.state.status || e.type === "tool_execution_start") this.pushUpdate(id);
  }

  private stopPoll(l: Live) { if (l.poll) { clearInterval(l.poll); l.poll = undefined; } }
  private async refreshState(id: string) {
    const l = this.map.get(id); if (!l) return;
    try { const st = await l.rpc.getState(); l.live.contextPercent = st.contextUsage?.percent; l.live.todoPhases = st.todoPhases;
      if (st.sessionId || st.sessionFile) this.registry.updateSession(id, { ompSessionId: st.sessionId, ompSessionFile: st.sessionFile });
      this.pushUpdate(id);
    } catch {}
  }

  sendMessage(id: string, text: string, mode: "prompt" | "follow_up" | "steer") {
    const l = this.map.get(id); if (!l) return;
    if (mode === "steer") l.rpc.steer(text); else if (mode === "follow_up") l.rpc.followUp(text); else l.rpc.prompt(text);
  }
  answerUi(id: string, res: RpcExtensionUIResponse) { this.map.get(id)?.rpc.answerUi(res); }
  async stopSession(id: string) { const l = this.map.get(id); if (!l) return; l.live.status = "stopped"; this.stopPoll(l); await l.rpc.stop(); this.registry.updateSession(id, { status: "stopped" }); this.pushUpdate(id); }
  async deleteSession(id: string) {
    const s = this.registry.listSessions().find((x) => x.id === id); const l = this.map.get(id);
    if (l) { this.stopPoll(l); await l.rpc.stop(); this.map.delete(id); }
    if (s) { const g = this.registry.listGroups().find((x) => x.id === s.groupId); if (g && s.worktreePath) await wt.removeWorktree(g.projectDir, s.worktreePath); }
    this.registry.removeSession(id); this.emit({ type: "session_removed", sessionId: id });
  }
  getTranscript(id: string): TranscriptEntry[] { return this.map.get(id)?.transcript ?? []; }
}
```

- [ ] **Step 2: Commit**

```bash
git add maestro/src/server/supervisor.ts
git commit -m "feat: session supervisor (rpc + status + worktree + registry)"
```

---

### Task 8: HTTP + WebSocket server

**Files:**
- Create: `maestro/src/server/server.ts`

**Interfaces:**
- Consumes: `Supervisor` (7), `Registry` (6), types (2).
- Produces: HTTP server on `http://localhost:4317`. REST endpoints (JSON):
  - `GET /api/groups`, `POST /api/groups {name,projectDir}`, `DELETE /api/groups/:id`
  - `GET /api/sessions?groupId=`, `POST /api/sessions {groupId,name,task,model?}`
  - `POST /api/sessions/:id/message {text,mode}`, `POST /api/sessions/:id/answer {res}`, `POST /api/sessions/:id/stop`, `DELETE /api/sessions/:id`
  - `GET /api/sessions/:id/transcript`
  - `GET /ws` → WebSocket; server sends a `snapshot` on connect, then `ServerEvent`s.

- [ ] **Step 1: Implement server**

```ts
// src/server/server.ts
import { homedir } from "os"; import { join } from "path"; import { mkdirSync } from "fs";
import { Registry } from "./registry"; import { Supervisor } from "./supervisor";

mkdirSync(join(homedir(), ".maestro"), { recursive: true });
const registry = new Registry(join(homedir(), ".maestro", "maestro.sqlite"));
const supervisor = new Supervisor(registry);
const sockets = new Set<any>();
supervisor.onServerEvent((e) => { const msg = JSON.stringify(e); for (const ws of sockets) ws.send(msg); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const err = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, 400);

Bun.serve({
  port: 4317,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/ws") { if (server.upgrade(req)) return; return new Response("upgrade failed", { status: 400 }); }
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } });
    try {
      if (p === "/api/groups" && req.method === "GET") return json(registry.listGroups());
      if (p === "/api/groups" && req.method === "POST") { const b = await req.json(); return json(await supervisor.addGroup(b.name, b.projectDir)); }
      let m = p.match(/^\/api\/groups\/(.+)$/); if (m && req.method === "DELETE") { supervisor.removeGroup(m[1]); return json({ ok: true }); }
      if (p === "/api/sessions" && req.method === "GET") return json(registry.listSessions(url.searchParams.get("groupId") ?? undefined));
      if (p === "/api/sessions" && req.method === "POST") { const b = await req.json(); return json(await supervisor.createSession(b.groupId, b.name, b.task, b.model)); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/message$/); if (m && req.method === "POST") { const b = await req.json(); supervisor.sendMessage(m[1], b.text, b.mode); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/answer$/); if (m && req.method === "POST") { const b = await req.json(); supervisor.answerUi(m[1], b.res); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/stop$/); if (m && req.method === "POST") { await supervisor.stopSession(m[1]); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/transcript$/); if (m && req.method === "GET") return json(supervisor.getTranscript(m[1]));
      m = p.match(/^\/api\/sessions\/([^/]+)$/); if (m && req.method === "DELETE") { await supervisor.deleteSession(m[1]); return json({ ok: true }); }
      return new Response("not found", { status: 404 });
    } catch (e) { return err(e); }
  },
  websocket: {
    open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "snapshot", ...supervisor.snapshot() })); },
    close(ws) { sockets.delete(ws); },
    message() {},
  },
});
console.log("Maestro server on http://localhost:4317");
```

- [ ] **Step 2: Smoke test the API**

Run backend: `cd maestro && bun run server`
In another shell verify against a real git repo (replace `/path/to/repo`):
```bash
curl -s localhost:4317/api/groups
curl -s -XPOST localhost:4317/api/groups -d '{"name":"demo","projectDir":"/path/to/repo"}' -H 'content-type: application/json'
```
Expected: empty array, then a created group JSON. Non-git dir → `{"error":"project dir is not a git repo"}`.

- [ ] **Step 3: Commit**

```bash
git add maestro/src/server/server.ts
git commit -m "feat: REST + websocket server"
```

---

### Task 9: Frontend scaffold + store

**Files:**
- Create: `maestro/web/index.html`, `maestro/web/vite.config.ts`, `maestro/web/src/main.tsx`, `maestro/web/src/api.ts`, `maestro/web/src/store.ts`, `maestro/web/src/App.tsx`

**Interfaces:**
- Consumes: server REST + WS (Task 8), types (Task 2, re-declared or imported from `../../src/server/types`).
- Produces: a Zustand store `useStore` exposing `{ groups, sessions, transcripts, selectedGroupId, selectedSessionId, connect(), selectGroup(id), selectSession(id) }` and `api` helpers `{ createGroup, createSession, sendMessage, answerUi, stopSession, deleteSession, loadTranscript }`.

- [ ] **Step 1: index.html + vite config + main**

```html
<!-- web/index.html -->
<!doctype html><html><head><meta charset="utf-8"><title>Maestro</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-neutral-950 text-neutral-100"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

```ts
// web/vite.config.ts
import { defineConfig } from "vite"; import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { port: 5317 } });
```

```tsx
// web/src/main.tsx
import { createRoot } from "react-dom/client"; import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 2: api.ts + store.ts**

```ts
// web/src/api.ts
const BASE = "http://localhost:4317";
const post = (p: string, body: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
export const api = {
  createGroup: (name: string, projectDir: string) => post("/api/groups", { name, projectDir }),
  createSession: (groupId: string, name: string, task: string, model?: string) => post("/api/sessions", { groupId, name, task, model }),
  sendMessage: (id: string, text: string, mode: string) => post(`/api/sessions/${id}/message`, { text, mode }),
  answerUi: (id: string, res: unknown) => post(`/api/sessions/${id}/answer`, { res }),
  stopSession: (id: string) => post(`/api/sessions/${id}/stop`, {}),
  deleteSession: (id: string) => fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }),
  loadTranscript: (id: string) => fetch(`${BASE}/api/sessions/${id}/transcript`).then((r) => r.json()),
};
```

```ts
// web/src/store.ts
import { create } from "zustand";
import type { Group, Session, TranscriptEntry, ServerEvent } from "../../src/server/types";
type State = {
  groups: Group[]; sessions: Session[]; transcripts: Record<string, TranscriptEntry[]>;
  selectedGroupId?: string; selectedSessionId?: string;
  connect(): void; selectGroup(id: string): void; selectSession(id?: string): void;
};
export const useStore = create<State>((set, get) => ({
  groups: [], sessions: [], transcripts: {},
  connect() {
    const ws = new WebSocket("ws://localhost:4317/ws");
    ws.onmessage = (ev) => {
      const e: ServerEvent = JSON.parse(ev.data);
      if (e.type === "snapshot") set({ groups: e.groups, sessions: e.sessions });
      if (e.type === "group_update") set((s) => ({ groups: [...s.groups.filter((g) => g.id !== e.group.id), e.group] }));
      if (e.type === "group_removed") set((s) => ({ groups: s.groups.filter((g) => g.id !== e.groupId) }));
      if (e.type === "session_update") set((s) => ({ sessions: [...s.sessions.filter((x) => x.id !== e.session.id), e.session] }));
      if (e.type === "session_removed") set((s) => ({ sessions: s.sessions.filter((x) => x.id !== e.sessionId) }));
      if (e.type === "transcript_append") set((s) => ({ transcripts: { ...s.transcripts, [e.sessionId]: [...(s.transcripts[e.sessionId] ?? []), e.entry] } }));
    };
  },
  selectGroup(id) { set({ selectedGroupId: id, selectedSessionId: undefined }); },
  selectSession(id) { set({ selectedSessionId: id }); },
}));
```

- [ ] **Step 3: App shell**

```tsx
// web/src/App.tsx
import { useEffect } from "react"; import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar"; import { SessionBoard } from "./components/SessionBoard"; import { SessionDetail } from "./components/SessionDetail";
export function App() {
  const connect = useStore((s) => s.connect); const selectedSessionId = useStore((s) => s.selectedSessionId);
  useEffect(() => { connect(); }, [connect]);
  return (<div className="flex h-screen"><Sidebar /><main className="flex-1 overflow-auto p-4">{selectedSessionId ? <SessionDetail /> : <SessionBoard />}</main></div>);
}
```

- [ ] **Step 4: Commit**

```bash
git add maestro/web
git commit -m "feat: frontend scaffold + store"
```

---

### Task 10: Sidebar + SessionBoard + SessionCard + NewSessionForm

**Files:**
- Create: `maestro/web/src/components/Sidebar.tsx`, `SessionBoard.tsx`, `SessionCard.tsx`, `NewSessionForm.tsx`

**Interfaces:**
- Consumes: `useStore`, `api` (Task 9), `Session`/`Group` types.
- Produces: React components; no exports consumed by later tasks except default component usage.

- [ ] **Step 1: Sidebar (groups + add group)**

```tsx
// web/src/components/Sidebar.tsx
import { useState } from "react"; import { useStore } from "../store"; import { api } from "../api";
const STATUS_DOT: Record<string, string> = { queued: "bg-neutral-500", thinking: "bg-blue-500", tool: "bg-amber-500", waiting_input: "bg-purple-500", done: "bg-green-600", error: "bg-red-600", stopped: "bg-neutral-600" };
export function Sidebar() {
  const { groups, sessions, selectedGroupId, selectGroup } = useStore();
  const [name, setName] = useState(""); const [dir, setDir] = useState("");
  return (
    <aside className="w-64 bg-neutral-900 border-r border-neutral-800 p-3 space-y-2 overflow-auto">
      <h1 className="text-lg font-semibold">Maestro</h1>
      {groups.map((g) => {
        const gs = sessions.filter((s) => s.groupId === g.id);
        return (<button key={g.id} onClick={() => selectGroup(g.id)} className={`w-full text-left px-2 py-1 rounded ${selectedGroupId === g.id ? "bg-neutral-800" : ""}`}>
          <div className="flex justify-between"><span>{g.name}</span><span className="text-xs text-neutral-400">{gs.length}</span></div>
          <div className="flex gap-1 mt-1">{gs.map((s) => <span key={s.id} className={`h-2 w-2 rounded-full ${STATUS_DOT[s.status] ?? "bg-neutral-500"}`} />)}</div>
        </button>);
      })}
      <div className="pt-2 border-t border-neutral-800 space-y-1">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="group name" className="w-full bg-neutral-800 px-2 py-1 rounded text-sm" />
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/git/repo" className="w-full bg-neutral-800 px-2 py-1 rounded text-sm" />
        <button onClick={async () => { try { await api.createGroup(name, dir); setName(""); setDir(""); } catch (e) { alert(e); } }} className="w-full bg-blue-700 rounded py-1 text-sm">Add group</button>
      </div>
    </aside>
  );
}
export { STATUS_DOT };
```

- [ ] **Step 2: SessionBoard + NewSessionForm**

```tsx
// web/src/components/SessionBoard.tsx
import { useStore } from "../store"; import { SessionCard } from "./SessionCard"; import { NewSessionForm } from "./NewSessionForm";
export function SessionBoard() {
  const { sessions, selectedGroupId, groups } = useStore();
  if (!selectedGroupId) return <p className="text-neutral-400">Select or add a group.</p>;
  const group = groups.find((g) => g.id === selectedGroupId);
  const gs = sessions.filter((s) => s.groupId === selectedGroupId);
  return (<div><h2 className="text-xl mb-3">{group?.name}</h2><div className="grid grid-cols-2 gap-3">{gs.map((s) => <SessionCard key={s.id} session={s} />)}</div><NewSessionForm groupId={selectedGroupId} /></div>);
}
```

```tsx
// web/src/components/NewSessionForm.tsx
import { useState } from "react"; import { api } from "../api";
export function NewSessionForm({ groupId }: { groupId: string }) {
  const [name, setName] = useState(""); const [task, setTask] = useState(""); const [model, setModel] = useState("");
  return (<div className="mt-4 p-3 bg-neutral-900 rounded space-y-2">
    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="session name" className="w-full bg-neutral-800 px-2 py-1 rounded text-sm" />
    <textarea value={task} onChange={(e) => setTask(e.target.value)} placeholder="task prompt" className="w-full bg-neutral-800 px-2 py-1 rounded text-sm h-20" />
    <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model (optional, e.g. opus)" className="w-full bg-neutral-800 px-2 py-1 rounded text-sm" />
    <button onClick={async () => { try { await api.createSession(groupId, name || "session", task, model || undefined); setName(""); setTask(""); } catch (e) { alert(e); } }} className="bg-green-700 rounded px-3 py-1 text-sm">Launch session</button>
  </div>);
}
```

- [ ] **Step 3: SessionCard**

```tsx
// web/src/components/SessionCard.tsx
import { useStore } from "../store"; import { STATUS_DOT } from "./Sidebar"; import type { Session } from "../../../src/server/types";
export function SessionCard({ session }: { session: Session }) {
  const selectSession = useStore((s) => s.selectSession);
  const activeTodo = session.todoPhases?.flatMap((p) => p.tasks).find((t) => t.status === "in_progress");
  return (<button onClick={() => selectSession(session.id)} className="text-left p-3 bg-neutral-900 rounded border border-neutral-800 hover:border-neutral-600">
    <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${STATUS_DOT[session.status] ?? "bg-neutral-500"}`} /><span className="font-medium">{session.name}</span></div>
    <div className="text-xs text-neutral-400 mt-1">{session.status}{session.currentTool ? ` · ${session.currentTool}` : ""}</div>
    {activeTodo && <div className="text-xs text-neutral-300 mt-1 truncate">▸ {activeTodo.content}</div>}
    {session.contextPercent != null && <div className="text-xs text-neutral-500 mt-1">ctx {(session.contextPercent * 100).toFixed(0)}%</div>}
  </button>);
}
```

- [ ] **Step 4: Smoke test the board**

Run backend (`bun run server`) and frontend (`bun run web` → open `http://localhost:5317`). Add a group pointing at a real git repo; launch a session with task "list top-level files then stop". Expected: a card appears; its status dot animates `queued → thinking → tool → done`; the in-progress todo and ctx% appear as omp reports them.

- [ ] **Step 5: Commit**

```bash
git add maestro/web/src/components
git commit -m "feat: sidebar + session board + cards"
```

---

### Task 11: SessionDetail + UiRequestWidget

**Files:**
- Create: `maestro/web/src/components/SessionDetail.tsx`, `UiRequestWidget.tsx`

**Interfaces:**
- Consumes: `useStore`, `api`, `TranscriptEntry`, `RpcExtensionUIRequest`.
- Produces: the drill-in view with transcript, input box, and approval widget.

- [ ] **Step 1: SessionDetail**

```tsx
// web/src/components/SessionDetail.tsx
import { useEffect, useState } from "react"; import { useStore } from "../store"; import { api } from "../api"; import { UiRequestWidget } from "./UiRequestWidget";
export function SessionDetail() {
  const { sessions, selectedSessionId, transcripts, selectSession } = useStore();
  const session = sessions.find((s) => s.id === selectedSessionId)!;
  const entries = transcripts[selectedSessionId!] ?? [];
  const [text, setText] = useState("");
  useEffect(() => { if (selectedSessionId && !transcripts[selectedSessionId]) api.loadTranscript(selectedSessionId).then((t) => useStore.setState((s) => ({ transcripts: { ...s.transcripts, [selectedSessionId]: t } }))); }, [selectedSessionId]);
  if (!session) return null;
  const mode = session.status === "done" ? "follow_up" : "steer";
  return (<div className="flex flex-col h-full">
    <div className="flex items-center gap-3 mb-2">
      <button onClick={() => selectSession(undefined)} className="text-neutral-400">← back</button>
      <h2 className="text-lg">{session.name}</h2><span className="text-xs text-neutral-400">{session.status}{session.currentTool ? ` · ${session.currentTool}` : ""}</span>
      <div className="ml-auto flex gap-2"><button onClick={() => api.stopSession(session.id)} className="text-xs bg-neutral-800 px-2 py-1 rounded">Stop</button><button onClick={() => { if (confirm("Delete session + worktree?")) { api.deleteSession(session.id); selectSession(undefined); } }} className="text-xs bg-red-800 px-2 py-1 rounded">Delete</button></div>
    </div>
    <div className="flex-1 overflow-auto space-y-2 bg-neutral-900 rounded p-3">
      {entries.map((e, i) => (<div key={i} className="text-sm">
        {e.kind === "assistant_text" && <div className="whitespace-pre-wrap">{e.text}</div>}
        {e.kind === "assistant_thinking" && <div className="text-neutral-500 italic whitespace-pre-wrap">{e.text}</div>}
        {e.kind === "tool_call" && <div className="text-amber-400">⚙ {e.tool}{e.summary ? `: ${e.summary}` : ""}</div>}
        {e.kind === "tool_result" && <div className={e.ok ? "text-green-500" : "text-red-500"}>{e.ok ? "✓" : "✗"} {e.tool}</div>}
        {e.kind === "notice" && <div className="text-neutral-400">{e.text}</div>}
      </div>))}
    </div>
    {session.pendingUiRequest && <UiRequestWidget sessionId={session.id} req={session.pendingUiRequest} />}
    <div className="mt-2 flex gap-2">
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text) { api.sendMessage(session.id, text, mode); setText(""); } }} placeholder={mode === "follow_up" ? "follow-up…" : "steer…"} className="flex-1 bg-neutral-800 px-3 py-2 rounded" />
    </div>
  </div>);
}
```

- [ ] **Step 2: UiRequestWidget (approval round-trip)**

```tsx
// web/src/components/UiRequestWidget.tsx
import { api } from "../api"; import type { RpcExtensionUIRequest } from "../../../src/server/types";
export function UiRequestWidget({ sessionId, req }: { sessionId: string; req: RpcExtensionUIRequest }) {
  const answer = (res: unknown) => api.answerUi(sessionId, { type: "extension_ui_response", id: req.id, ...(res as object) });
  return (<div className="mt-2 p-3 bg-purple-950 border border-purple-700 rounded">
    <div className="text-sm mb-2">{req.title ?? req.method}{req.message ? `: ${req.message}` : ""}</div>
    {req.method === "confirm" && <div className="flex gap-2"><button onClick={() => answer({ confirmed: true })} className="bg-green-700 px-3 py-1 rounded text-sm">Yes</button><button onClick={() => answer({ confirmed: false })} className="bg-neutral-700 px-3 py-1 rounded text-sm">No</button></div>}
    {req.method === "select" && <div className="flex flex-wrap gap-2">{(req.options ?? []).map((o) => <button key={o} onClick={() => answer({ value: o })} className="bg-blue-700 px-3 py-1 rounded text-sm">{o}</button>)}</div>}
    {req.method === "input" && <InputAnswer onSubmit={(v) => answer({ value: v })} placeholder={req.placeholder} />}
  </div>);
}
function InputAnswer({ onSubmit, placeholder }: { onSubmit: (v: string) => void; placeholder?: string }) {
  return (<input autoFocus placeholder={placeholder} onKeyDown={(e) => { if (e.key === "Enter") onSubmit((e.target as HTMLInputElement).value); }} className="w-full bg-neutral-800 px-2 py-1 rounded text-sm" />);
}
```

- [ ] **Step 3: Commit**

```bash
git add maestro/web/src/components/SessionDetail.tsx maestro/web/src/components/UiRequestWidget.tsx
git commit -m "feat: session detail + approval widget"
```

---

### Task 12: End-to-end verification (two parallel isolated sessions)

**Files:** none (verification only). If wiring gaps surface, fix in the owning module and amend its task's commit.

- [ ] **Step 1: Full unit suite**

Run: `cd maestro && bun test`
Expected: PASS (rpc-frames, status, worktree, registry).

- [ ] **Step 2: End-to-end smoke**

1. `bun run server` and `bun run web`; open `http://localhost:5317`.
2. Add a group on a real git repo.
3. Launch two sessions with different tasks (e.g. "add a comment to README top" and "list src files then stop").
4. Confirm: two cards, independent live status; two directories exist under `~/.maestro/worktrees/`; two branches `maestro/*` exist (`git -C <repo> worktree list`).
5. Open a session that triggers an approval; confirm the purple `waiting_input` widget appears and answering unblocks it.
6. Delete one session; confirm its worktree is removed (`git -C <repo> worktree list`).

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "test: end-to-end maestro MVP verification"
```

---

## Self-Review

**Spec coverage:**
- Grouping by project → Tasks 6 (registry), 8 (API), 10 (sidebar). ✓
- Parallel sessions per group, worktree-isolated → Tasks 5 (worktree), 7 (supervisor create), 12 (two-session check). ✓
- Visual session state (queued/thinking/tool/waiting_input/done/error/stopped + todos + ctx%) → Tasks 4 (reducer), 7 (get_state polling), 10 (card). ✓
- Drill-in transcript + input + approval → Task 11. ✓
- RPC integration, no terminal parsing → Tasks 1–3, 7. ✓
- Persistence pointers to omp session file → Tasks 6, 7 (`refreshState` writes ompSessionId/File). ✓
- Verification = smoke test + targeted unit tests → Tasks 4/5/6/2 units, 8/10/12 smoke. ✓
- Non-goals (`/tree`, merge, desktop) → excluded. ✓

**Placeholder scan:** No TBD/TODO; each code step is concrete.

**Type consistency:** `Session`, `SessionStatus`, `TranscriptEntry`, `RpcEvent`, `ServerEvent`, `RpcExtensionUIRequest/Response` defined once in `types.ts` (Task 2) and reused verbatim in Tasks 3–11. `reduceStatus`/`INITIAL_STATUS` (Task 4) consumed by Task 7. `Registry`/`Supervisor` method signatures in Tasks 6/7 match calls in Task 8. Worktree helpers (Task 5) match Task 7 usage.

**Open item to confirm during Task 1 spike:** exact `extension_ui_request` field names for `select`/`input` (used in Task 11). If they differ from the documented `options`/`placeholder`, adjust `UiRequestWidget` accordingly.
