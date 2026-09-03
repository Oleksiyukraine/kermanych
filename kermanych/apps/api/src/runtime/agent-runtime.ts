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
