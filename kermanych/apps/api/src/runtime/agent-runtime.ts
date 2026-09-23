// apps/api/src/runtime/agent-runtime.ts
import type { RpcEvent, RpcExtensionUIResponse, ImageInput, ThinkingLevel, TodoPhase, AgentRuntimeKind, SubagentSubscriptionLevel, SubagentInfo, SubagentMessagesPage } from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";
import { ClaudeCodeRuntime } from "./claude-code-runtime";

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
// `fork` seeds a NEW session from a prior one (branch/discussion); `resume` continues an
// existing session in place (claude reopen); `thinking` is the opening effort.
export interface RuntimeLaunchOpts {
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  fork?: string;
  resume?: string;
  noTools?: boolean;
  tools?: string[];
  // Extra text appended to the system prompt (backend-neutral). omp maps it to
  // `--append-system-prompt`, claude to `systemPrompt.append`. Used to inject the user's
  // agent communication language directive.
  appendSystemPrompt?: string;
  commandTimeoutMs?: number;
  // How long a claude child is watched for an immediate death before start() calls the launch
  // a success. claude-only (omp's start() awaits its own `ready` frame and needs no window);
  // overridden in tests so they never sleep the real default.
  startGraceMs?: number;
  configPath?: string;   // omp-only
  extensionPath?: string; // omp-only
  // How much of omp's subagent activity to forward (omp defaults to "off"). Ignored by
  // non-omp backends. Undefined lets the omp runtime pick its own default ("progress").
  subagentSubscription?: SubagentSubscriptionLevel; // omp-only
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
  // transcript read incrementally. Non-omp backends have no subagent registry yet and return
  // empty (claude linkage is via parent_agent_id, not surfaced this increment).
  getSubagents(): Promise<SubagentInfo[]>;
  getSubagentMessages(sel: { subagentId?: string; sessionFile?: string; fromByte?: number }): Promise<SubagentMessagesPage>;
  stop(): Promise<void>;
  onEvent(cb: (e: RpcEvent) => void): void;
  onExit(cb: (code: number | null, reason: string) => void): void;
}

export function createRuntime(kind: AgentRuntimeKind, opts: RuntimeLaunchOpts): AgentRuntime {
  if (kind === "omp") return new RpcSession(opts);
  return new ClaudeCodeRuntime(opts);
}
