// apps/api/src/assistant/rpc-chat-pool.ts
// The mechanics every chat assistant of the api shares — the Менеджмент assistant
// (management-chat.service.ts) and ЦУК (cuk-chat.service.ts): one agent child per
// conversation key on the user's own backend, driven turn by turn, with a per-key turn
// queue, a start and a turn timeout, idle eviction, and the event loop that turns one omp
// burst into one reply. What each assistant adds — attachments on disk, Jira tools, its own
// prompt and parser — is layered on top by the owning service through `launch` and the hooks.
//
// Deliberately NOT a SupervisorService session: there is no branch, no worktree, no registry
// row and no board entry behind a chat, and giving it a session would put a phantom card on
// the operator's board every time somebody asked a question.
import { Logger } from "@nestjs/common";
import {
  INTERACTIVE_UI_METHODS,
  type ImageInput,
  type Notice,
  type RpcEvent,
  type Usage,
} from "@kermanych/core";
import { createRuntime, type AgentRuntime, type RuntimeLaunchOpts } from "../runtime/agent-runtime";
import { languageAppendFor } from "../runtime/resolve-language";
import { limit } from "../runtime/limit";
import { CodedError } from "../management/coded-error";
import type { RegistryService } from "../registry/registry.service";
import type { MachineResourcesService } from "../machine/machine-resources.service";
import { reduceRpcEvents, sumTurnUsage } from "../supervisor/transcript-reducer";

// `omp --mode rpc` loads its config, its skill library and the provider client before it
// emits `ready`; cold on a laptop that is a couple of seconds, and the slowest observed
// start is well under ten. Thirty seconds therefore no longer describes a slow machine —
// it describes an `omp` that is missing from PATH or wedged, and the operator is better
// served by a readable error than by a request that never returns.
const START_TIMEOUT_MS = 30_000;

// Every live conversation is a resident omp process. Half an hour is longer than any
// pause inside one working session and shorter than a lunch break, so the operator who
// comes back to the tab keeps their context, and the tab nobody closed stops costing a
// process.
const IDLE_TTL_MS = 30 * 60_000;

// The sink the live child's single event/exit callback feeds. `RpcSession.onEvent` only
// ever pushes onto its callback list — there is no way to remove a callback — so exactly one
// pair is registered per child and each turn swaps what it points at. A per-turn callback
// would still be attached on turn two, and turn one's collector would quietly accumulate
// turn two's frames.
type Turn = { on: (e: RpcEvent) => void; fail: (reason: string) => void };

// One live child. `extra` is the owning service's per-child state (the Менеджмент chat's
// Jira tool binding), released through `hooks.release` whenever the child is discarded.
export type ChatChild<X> = { rpc: AgentRuntime; greeted: boolean; lastAt: number; turn?: Turn; extra?: X };

// What one spawn needs from the owner. The backend, the language directive and the renice
// are the pool's — every chat child gets them the same way.
export type ChatLaunch<X> = {
  opts: Omit<RuntimeLaunchOpts, "appendSystemPrompt" | "onSpawn">;
  extra?: X;
};

export type ChatPoolConfig<X> = {
  // Names the pool in the debug log («management chat», «cuk chat»).
  label: string;
  // How long one turn may take before the child is dropped — the owner's call, because a
  // turn that greps three repositories and a turn with no tools are different budgets.
  turnTimeoutMs: number;
  registry: RegistryService;
  // The machine resource profile lowers the child's priority like every agent's
  // (docs/specs/2026-10-21-machine-resource-profile.md, decision 6). Optional for specs.
  resources?: MachineResourcesService;
  // Releases the owner's per-child state (an MCP bearer) when a child is discarded.
  release?: (extra: X) => void;
  // Best-effort cleanup of the owner's per-key state when a conversation is dropped (timeout,
  // idle eviction, shutdown) — live child or not. Not awaited.
  onDrop?: (key: string) => void;
};

// The prose and the accounting of one finished turn, read off its events.
export type ChatTurnRead = { raw: string; usage?: Usage; model?: string };

export class RpcChatPool<X = never> {
  private readonly log: Logger;
  private map = new Map<string, ChatChild<X>>();
  // The per-conversation turn queue. Keyed by conversation and kept OUTSIDE the child,
  // because it has to outlive it: a turn that times out drops its omp process, and the ask
  // already queued behind it must run after that — never beside it. Two asks sharing one
  // child is the corruption this prevents: both write to the same stdin, the first
  // `agent_end` resolves whichever turn is listening, and one operator's answer is handed to
  // the other's question.
  private tail = new Map<string, Promise<unknown>>();

  constructor(private cfg: ChatPoolConfig<X>) {
    this.log = new Logger(cfg.label);
  }

  // Run `run` after every turn already queued on `key`.
  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    // `then(run, run)` and not `finally`: a rejected predecessor must not cancel the ask
    // behind it, and the queue must not stay poisoned by one failed turn.
    const next = this.tail.get(key)?.then(run, run) ?? run();
    this.tail.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // The live child for a conversation, spawned on first use and respawned when the
  // previous one died between turns. A dead child must never be written to: the write to
  // its closed stdin is swallowed (the stdin 'error' handler in `RpcSession.start()`), so
  // the message would vanish and the turn would hang until the turn timeout for no reason
  // at all.
  async child(key: string, launch: () => ChatLaunch<X>): Promise<ChatChild<X>> {
    const cur = this.map.get(key);
    if (cur?.rpc.isAlive()) {
      cur.lastAt = Date.now();
      return cur;
    }
    if (cur) {
      this.map.delete(key);
      this.release(cur);
      await cur.rpc.stop().catch(() => {});
    }
    const { opts, extra } = launch();
    const append = languageAppendFor(this.cfg.registry.getAuthSession()?.agentLanguage);
    const rpc = createRuntime({
      ...opts,
      ...(append ? { appendSystemPrompt: append } : {}),
      onSpawn: (pid) => this.cfg.resources?.renice(pid),
    });
    const live: ChatChild<X> = { rpc, greeted: false, lastAt: Date.now(), ...(extra !== undefined ? { extra } : {}) };
    rpc.onEvent((e) => live.turn?.on(e));
    rpc.onExit((_code, reason) => live.turn?.fail(reason));
    try {
      const seconds = Math.round(START_TIMEOUT_MS / 1000);
      await limit(
        rpc.start(),
        START_TIMEOUT_MS,
        new CodedError(
          "omp_launch_timeout",
          `не вдалося запустити omp за ${seconds} с — перевірте, що команда omp доступна в PATH`,
          { seconds },
        ),
      );
    } catch (err) {
      // `limit` abandons the start promise; it does not kill the process behind it. An omp
      // that greets late is therefore still running, unreferenced, holding a provider seat
      // — and the operator's natural next move is to retry, orphaning one more each time.
      // The child is never put in `map` on this path, so this is the only chance to stop it.
      await rpc.stop().catch(() => {});
      this.release(live);
      throw err;
    }
    this.map.set(key, live);
    this.log.debug(`${key}: omp запущено в ${opts.cwd}`);
    return live;
  }

  // Send one message and wait out the turn it starts.
  async drive(
    key: string,
    live: ChatChild<X>,
    message: string,
    images: ImageInput[],
  ): Promise<{ events: RpcEvent[]; notices: Notice[] }> {
    const events: RpcEvent[] = [];
    const notices: Notice[] = [];
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const droppedBefore = live.rpc.droppedFrames;
    live.turn = {
      on: (e) => {
        events.push(e);
        if (e.type === "extension_ui_request") {
          // Narrowed the way core/status.ts narrows the same frame: `RpcEvent` ends in an
          // index-signature member, so `e.method` is `unknown` until `typeof` proves it.
          const method = "method" in e && typeof e.method === "string" ? e.method : undefined;
          const id = "id" in e && typeof e.id === "string" ? e.id : undefined;
          if (method === undefined || id === undefined || INTERACTIVE_UI_METHODS[method] !== true) return;
          // There is no operator surface behind this route: the ui posts one question and
          // waits for one reply, so nothing can ever answer an interactive prompt. Left
          // unanswered, omp blocks on it and the turn burns the whole turn timeout before
          // failing. Cancel it at once and tell the user the model tried to ask this way —
          // each contract's «no interactive prompts» rule exists to stop it happening twice.
          live.rpc.answerUi({ type: "extension_ui_response", id, cancelled: true });
          notices.push({
            text: `асистент спробував запитати через інтерактивне вікно (${method}) — запит скасовано, бо в цьому чаті немає де на нього відповісти`,
            code: "interactive_request_cancelled",
            params: { method },
          });
          return;
        }
        if (e.type === "agent_end") {
          // `isTerminal: false` marks a sub-agent's end, not the answer's (core/status.ts
          // reads it the same way): resolving on it would return half a turn.
          const isTerminal = "isTerminal" in e ? e.isTerminal : undefined;
          if (isTerminal !== false) resolve();
        }
      },
      fail: (reason) =>
        reject(new CodedError("omp_exited_during_reply", `omp завершився під час відповіді: ${reason}`, { reason })),
    };
    try {
      // First turn carries the contract and opens the conversation; every later one is a
      // follow_up into the same child, which is what keeps the contract worth sending once.
      if (live.greeted) live.rpc.followUp(message, images);
      else live.rpc.prompt(message, images);
      live.greeted = true;
      const seconds = Math.round(this.cfg.turnTimeoutMs / 1000);
      await limit(
        promise,
        this.cfg.turnTimeoutMs,
        new CodedError(
          "assistant_no_reply_timeout",
          `асистент не відповів за ${seconds} с — розмову перезапущено, спробуйте ще раз`,
          { seconds },
        ),
      );
    } catch (err) {
      // Timed out or died: either way this child can no longer be trusted with the next
      // turn — its stdin may hold half a message, and a late `agent_end` would resolve
      // somebody else's question. Drop it so the next ask starts clean.
      this.drop(key);
      throw err;
    } finally {
      live.turn = undefined;
    }
    live.lastAt = Date.now();
    const lost = live.rpc.droppedFrames - droppedBefore;
    // Silent loss is the one failure a chat must never present as a complete answer.
    if (lost > 0)
      notices.push({
        text: `втрачено ${lost} кадр(ів) від omp — частина відповіді могла не дійти`,
        code: "frames_lost",
        params: { count: lost },
      });
    return { events, notices };
  }

  // «Новий чат» has to mean it: the child holds the whole conversation, so forgetting the
  // row without killing the process would leave the next question answered in the light of
  // the one the operator just discarded. The child is detached BEFORE `cleanup` is awaited,
  // so an ask arriving meanwhile spawns a fresh child instead of reusing this one.
  async reset(key: string, cleanup?: () => Promise<void>): Promise<void> {
    const live = this.map.get(key);
    this.map.delete(key);
    this.tail.delete(key);
    await cleanup?.();
    if (!live) return;
    this.release(live);
    // An in-flight turn is told why it will never finish. Stopping the child first would
    // surface as `onExit` on a callback we are about to clear, i.e. as a hang.
    live.turn?.fail("розмову скинуто");
    live.turn = undefined;
    await live.rpc.stop().catch(() => {});
  }

  drop(key: string): void {
    this.cfg.onDrop?.(key);
    const live = this.map.get(key);
    if (!live) return;
    this.map.delete(key);
    live.turn = undefined;
    this.release(live);
    void live.rpc.stop().catch(() => {});
  }

  // A leaked omp child outlives the api and keeps spending the plan, so every one is
  // stopped. The stops are not awaited: Nest's shutdown has no budget worth blocking on,
  // and `stop()` already escalates to a kill.
  dropAll(): void {
    for (const key of [...this.map.keys()]) this.drop(key);
  }

  // Idle eviction on use, not on a timer: a conversation nobody has touched for the TTL is
  // a tab somebody closed, and its omp child is a resident process. A `setInterval` janitor
  // would wake this process — and keep the machine awake — every minute forever just to
  // find nothing to do, so the sweep rides on the next ask/reset instead.
  sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [key, live] of [...this.map]) {
      // Never evict a conversation mid-turn: `turn` is set exactly while one is in flight.
      if (live.turn || live.lastAt >= cutoff) continue;
      this.drop(key);
      this.tail.delete(key);
    }
  }

  private release(live: ChatChild<X>): void {
    if (live.extra !== undefined) this.cfg.release?.(live.extra);
  }
}

// The reply's prose and spend, read off one turn's events. The reduction is the supervisor's,
// not a second copy of it: the same events that build a session transcript build this reply,
// so an omp frame that changes meaning changes meaning in one place. Notices the reduction
// finds are appended to `notices`. Usage is summed across the turn's assistant messages by
// the shared helper, so every chat and the release-notes generator report a turn's spend
// with the same arithmetic.
export function readTurn(events: RpcEvent[], notices: Notice[], startedAt: number): ChatTurnRead {
  const { entries } = reduceRpcEvents(events);
  const texts: string[] = [];
  for (const e of entries) {
    if (e.kind === "assistant_text") texts.push(e.text);
    else if (e.kind === "notice")
      notices.push({ text: e.text, ...(e.code ? { code: e.code } : {}), ...(e.params ? { params: e.params } : {}) });
  }
  const { usage, model } = sumTurnUsage(events, startedAt);
  return {
    raw: texts.join("\n\n"),
    ...(usage === undefined ? {} : { usage }),
    ...(model === undefined ? {} : { model }),
  };
}
