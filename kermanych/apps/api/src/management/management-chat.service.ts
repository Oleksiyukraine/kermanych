// apps/api/src/management/management-chat.service.ts
// The Менеджмент assistant: one `omp --mode rpc` child per conversation, driven turn by
// turn over the same binary, provider account and subscription every agent uses — so a
// question asked here is debited exactly where an agent's work is debited, and the reply
// says so (`usage`).
//
// Deliberately NOT a SupervisorService session: there is no branch, no worktree, no
// registry row and no board entry behind this chat. It is a conversation about the
// management surface that happens to be able to read the workspace's repositories, and
// giving it a session would put a phantom card on the operator's board every time somebody
// asked what the risk register says.
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import {
  INTERACTIVE_UI_METHODS,
  expandHelpers,
  helperNotice,
  parseManagementReply,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ManagementRepo,
  type RpcEvent,
} from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";
import { RegistryService } from "../registry/registry.service";
import { reduceRpcEvents, sumTurnUsage } from "../supervisor/transcript-reducer";
import { buildManagementTurn, managementCwd, managementRepos, todayIso } from "./management-prompt";

// Read-only, and not a setting: a management chat that can write to the repository is a
// different — and far more dangerous — product than one that reads it to answer about
// risks. The same subset the quick chats run with (supervisor.service.ts CHAT_TOOLS),
// which is the existing proof that omp is happy in a bare project directory with no git
// and no edit tools.
export const MANAGEMENT_TOOLS = ["read", "grep", "glob"] as const;

// `omp --mode rpc` loads its config, its skill library and the provider client before it
// emits `ready`; cold on a laptop that is a couple of seconds, and the slowest observed
// start is well under ten. Thirty seconds therefore no longer describes a slow machine —
// it describes an `omp` that is missing from PATH or wedged, and the operator is better
// served by a readable error than by a request that never returns.
const START_TIMEOUT_MS = 30_000;

// A legitimate turn here can grep three repositories before it answers: each tool round
// trip is a provider call plus disk work, and five of them at ten seconds each is a normal
// — not a broken — answer about the state of a workspace. Four minutes is the first number
// that cannot be reached by honest work, so hitting it means the child is stuck, and the
// child is dropped rather than retried.
const TURN_TIMEOUT_MS = 240_000;

// Every live conversation is a resident omp process. Half an hour is longer than any
// pause inside one working session and shorter than a lunch break, so the operator who
// comes back to the tab keeps their context, and the tab nobody closed stops costing a
// process.
const IDLE_TTL_MS = 30 * 60_000;

// The sink the live child's single event/exit callback feeds. `RpcSession.onEvent` only
// ever pushes (rpc-session.ts:41) — there is no way to remove a callback — so exactly one
// pair is registered per child and each turn swaps what it points at. A per-turn callback
// would still be attached on turn two, and turn one's collector would quietly accumulate
// turn two's frames.
type Turn = { on: (e: RpcEvent) => void; fail: (reason: string) => void };

type Live = { rpc: RpcSession; greeted: boolean; lastAt: number; turn?: Turn };

// RpcSession bounds its command round trips (`commandTimeoutMs`) but neither `start()` nor
// a turn, and neither does omp bound a provider request that never answers. Without this
// the http request would stay open until the browser gave up, with nothing the operator
// could read or act on. Exported for the release-notes generator, which bounds the same
// two waits over the same kind of child.
export async function limit<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class ManagementChatService implements OnModuleDestroy {
  private readonly log = new Logger(ManagementChatService.name);
  private map = new Map<string, Live>();
  // The per-conversation turn queue. Keyed by conversation and kept OUTSIDE `Live`,
  // because it has to outlive the child: a turn that times out drops its omp process, and
  // the ask already queued behind it must run after that — never beside it. Two asks
  // sharing one child is the corruption this prevents: both write to the same stdin, the
  // first `agent_end` resolves whichever turn is listening, and one operator's answer is
  // handed to the other's question.
  private tail = new Map<string, Promise<unknown>>();

  constructor(private registry: RegistryService) {}

  async ask(input: ManagementChatAsk): Promise<ManagementChatReply> {
    const startedAt = Date.now();
    this.sweep();
    // A workspace whose projects are all unbound on this machine — or which holds none at
    // all — still gets a working chat: `managementRepos` drops the ids the registry does not
    // know and `managementCwd` then falls back to `homedir()`. The assistant's subject is
    // the management surface, not the source, so there is nothing to refuse here.
    const repos = managementRepos(this.registry.listProjects(), input.workspaceProjects);
    const key = input.conversationId;
    const run = (): Promise<ManagementChatReply> => this.turn(key, repos, input, startedAt);
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

  // «Новий чат» has to mean it: the child holds the whole conversation, so forgetting the
  // row without killing the process would leave the next question answered in the light of
  // the one the operator just discarded.
  async reset(conversationId: string): Promise<{ ok: true }> {
    this.sweep();
    const live = this.map.get(conversationId);
    this.map.delete(conversationId);
    this.tail.delete(conversationId);
    if (!live) return { ok: true };
    // An in-flight turn is told why it will never finish. Stopping the child first would
    // surface as `onExit` on a callback we are about to clear, i.e. as a hang.
    live.turn?.fail("розмову скинуто");
    live.turn = undefined;
    await live.rpc.stop().catch(() => {});
    return { ok: true };
  }

  onModuleDestroy(): void {
    // A leaked omp child outlives the api and keeps spending the plan, so every one is
    // stopped. The stops are not awaited: Nest's shutdown has no budget worth blocking on,
    // and `stop()` already escalates to a kill.
    for (const key of [...this.map.keys()]) this.drop(key);
  }

  private async turn(
    key: string,
    repos: ManagementRepo[],
    input: ManagementChatAsk,
    startedAt: number,
  ): Promise<ManagementChatReply> {
    const live = await this.child(key, repos);
    const first = !live.greeted;
    // Хелпери are expanded HERE rather than inside buildManagementTurn: that function wraps
    // the operator's text in the contract and the context markers, so by the time the child
    // reads it a leading `/el10` is no longer leading and would expand nowhere.
    const helped = expandHelpers(input.text);
    const message = buildManagementTurn({
      first,
      repos,
      context: input.context,
      today: todayIso(),
      text: helped.text,
    });
    const { events, notices } = await this.drive(key, live, message);
    // First, because it describes the message that produced everything after it.
    if (helped.used.length) notices.unshift(helperNotice(helped.used));

    // The reduction is the supervisor's, not a second copy of it: the same events that
    // build a session transcript build this reply, so an omp frame that changes meaning
    // changes meaning in one place.
    const { entries } = reduceRpcEvents(events);
    const texts: string[] = [];
    for (const e of entries) {
      if (e.kind === "assistant_text") texts.push(e.text);
      else if (e.kind === "notice") notices.push(e.text);
    }

    // Summed across the turn's assistant messages by the shared helper, so this reply and
    // the release-notes generator report a turn's spend with the same arithmetic.
    const { usage, model } = sumTurnUsage(events, startedAt);

    const parsed = parseManagementReply(texts.join("\n\n"));
    return {
      text: parsed.text,
      actions: parsed.actions,
      rejected: parsed.rejected,
      notices,
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it — the queue wait and the spawn included,
      // because that is what they sat through.
      ms: Date.now() - startedAt,
    };
  }

  // The live child for a conversation, spawned on first use and respawned when the
  // previous one died between turns. A dead child must never be written to: the write to
  // its closed stdin is swallowed (rpc-session.ts:181-186), so the message would vanish
  // and the turn would hang until TURN_TIMEOUT_MS for no reason at all.
  private async child(key: string, repos: ManagementRepo[]): Promise<Live> {
    const cur = this.map.get(key);
    if (cur?.rpc.isAlive()) {
      cur.lastAt = Date.now();
      return cur;
    }
    if (cur) {
      this.map.delete(key);
      await cur.rpc.stop().catch(() => {});
    }
    const cwd = managementCwd(repos);
    const rpc = new RpcSession({ cwd, tools: [...MANAGEMENT_TOOLS] });
    const live: Live = { rpc, greeted: false, lastAt: Date.now() };
    rpc.onEvent((e) => live.turn?.on(e));
    rpc.onExit((_code, reason) => live.turn?.fail(reason));
    try {
      await limit(
        rpc.start(),
        START_TIMEOUT_MS,
        `не вдалося запустити omp за ${Math.round(START_TIMEOUT_MS / 1000)} с — перевірте, що команда omp доступна в PATH`,
      );
    } catch (err) {
      // `limit` abandons the start promise; it does not kill the process behind it. An omp
      // that greets late is therefore still running, unreferenced, holding a provider seat
      // — and the operator's natural next move is to retry, orphaning one more each time.
      // The child is never put in `map` on this path, so this is the only chance to stop it.
      await rpc.stop().catch(() => {});
      throw err;
    }
    this.map.set(key, live);
    this.log.debug(`management chat ${key}: omp запущено в ${cwd}`);
    return live;
  }

  // Send one message and wait out the turn it starts.
  private async drive(key: string, live: Live, message: string): Promise<{ events: RpcEvent[]; notices: string[] }> {
    const events: RpcEvent[] = [];
    const notices: string[] = [];
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
          // the prompt's rule (г) exists to stop it happening twice.
          live.rpc.answerUi({ type: "extension_ui_response", id, cancelled: true });
          notices.push(
            `асистент спробував запитати через інтерактивне вікно (${method}) — запит скасовано, бо в цьому чаті немає де на нього відповісти`,
          );
          return;
        }
        if (e.type === "agent_end") {
          // `isTerminal: false` marks a sub-agent's end, not the answer's (core/status.ts
          // reads it the same way): resolving on it would return half a turn.
          const isTerminal = "isTerminal" in e ? e.isTerminal : undefined;
          if (isTerminal !== false) resolve();
        }
      },
      fail: (reason) => reject(new Error(`omp завершився під час відповіді: ${reason}`)),
    };
    try {
      // First turn carries the contract and opens the conversation; every later one is a
      // follow_up into the same child, which is what keeps the contract worth sending once.
      if (live.greeted) live.rpc.followUp(message);
      else live.rpc.prompt(message);
      live.greeted = true;
      await limit(
        promise,
        TURN_TIMEOUT_MS,
        `асистент не відповів за ${Math.round(TURN_TIMEOUT_MS / 1000)} с — розмову перезапущено, спробуйте ще раз`,
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
    // Silent loss is the one failure this chat must never present as a complete answer.
    if (lost > 0) notices.push(`втрачено ${lost} кадр(ів) від omp — частина відповіді могла не дійти`);
    return { events, notices };
  }

  private drop(key: string): void {
    const live = this.map.get(key);
    if (!live) return;
    this.map.delete(key);
    live.turn = undefined;
    void live.rpc.stop().catch(() => {});
  }

  // Idle eviction on use, not on a timer: a conversation nobody has touched for the TTL is
  // a tab somebody closed, and its omp child is a resident process. A `setInterval` janitor
  // would wake this process — and keep the machine awake — every minute forever just to
  // find nothing to do, so the sweep rides on the next ask/reset instead.
  private sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [key, live] of [...this.map]) {
      // Never evict a conversation mid-turn: `turn` is set exactly while one is in flight.
      if (live.turn || live.lastAt >= cutoff) continue;
      this.drop(key);
      this.tail.delete(key);
    }
  }
}
