// apps/api/src/runtime/agent-runtime.ts
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel, TodoPhase, SubagentSubscriptionLevel, SubagentInfo, SubagentMessagesPage } from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";
import type { AuthFailureCode } from "./auth-failure";

// The state contract a runtime reports through getState(), filled from omp's `get_state` frame.
export interface RpcStateData {
  isStreaming: boolean;
  contextUsage?: { percent: number };
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  sessionId?: string;
  sessionFile?: string;
  todoPhases?: TodoPhase[];
}

// Normalized launch inputs. configPaths/extensionPath = config overlays + trigger package.
// `tools`/`noTools` restrict the toolset; `fork` seeds a NEW session from a prior one
// (branch/discussion); `thinking` is the opening effort.
export interface RuntimeLaunchOpts {
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  fork?: string;
  noTools?: boolean;
  tools?: string[];
  // Extra text appended to the system prompt (`--append-system-prompt`). Used to inject the
  // user's agent communication language directive.
  appendSystemPrompt?: string;
  commandTimeoutMs?: number;
  // omp `--config` overlays, applied in order (later wins): the project's skill library and the
  // machine resource limits (task.maxConcurrency, bash.autoBackground.enabled). omp-only.
  configPaths?: string[];
  extensionPath?: string;
  // How much of omp's subagent activity to forward (omp defaults to "off"). Undefined lets
  // the runtime pick its own default ("progress").
  subagentSubscription?: SubagentSubscriptionLevel;
  // One HTTP MCP server whose tools the child gets beside its built-ins — the Менеджмент
  // chat's Jira tools (management-mcp.service.ts). omp reads MCP only from config files, so it
  // gets the omp-mcp-bridge.ts extension with the URL and bearer in its environment; the
  // tools appear under their bare names.
  mcp?: { name: string; url: string; token: string };
  // Extra environment merged over process.env for the child.
  env?: Record<string, string>;
  // Called synchronously once the agent process exists, with its pid, before it reports
  // ready: the supervisor renices it then, so the MCP servers and workers it starts inherit
  // the lower priority, and keeps the pid for the memory watchdog.
  onSpawn?: (pid: number) => void;
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
  // Compact the conversation context in place: omp summarizes the older history behind a
  // compaction boundary, freeing token budget while keeping recent turns verbatim.
  // `customInstructions` steers the summary's focus. Resolves once the child confirms.
  compact(customInstructions?: string): Promise<void>;
  getAllMessages(): Promise<unknown[]>;
  // omp's subagent surface: the registry snapshot the agent map lists, and one subagent's
  // transcript read incrementally.
  getSubagents(): Promise<SubagentInfo[]>;
  getSubagentMessages(sel: { subagentId?: string; sessionFile?: string; fromByte?: number }): Promise<SubagentMessagesPage>;
  stop(): Promise<void>;
  onEvent(cb: (e: RpcEvent) => void): void;
  // `cause` is the auth-failure code (auth-failure.ts) when the runtime recognised why the
  // child died — a signed-out CLI, a missing binary — so callers need not re-read `reason`.
  onExit(cb: (code: number | null, reason: string, cause?: AuthFailureCode) => void): void;
}

export function createRuntime(opts: RuntimeLaunchOpts): AgentRuntime {
  return new RpcSession(opts);
}
