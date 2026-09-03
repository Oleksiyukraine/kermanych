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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import {
  INTERACTIVE_UI_METHODS,
  expandHelpers,
  helperNotice,
  parseManagementReply,
  type ImageInput,
  type ManagementAttachment,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ManagementRepo,
  type Notice,
  type RpcEvent,
} from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";
import { CodedError } from "./coded-error";
import { RegistryService } from "../registry/registry.service";
import { reduceRpcEvents, sumTurnUsage } from "../supervisor/transcript-reducer";
import {
  buildManagementTurn,
  managementCwd,
  managementRepos,
  todayIso,
  type ManagementTurnFile,
} from "./management-prompt";

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

// How many of a conversation's file names one turn carries. The block is a reminder, not
// an archive: ten files per message is the controller's own cap, and a chat that has
// exchanged dozens is one where the oldest names are no longer what «прикріпи файл» means.
// Only the LIST is trimmed — the documents stay on disk for the read tool, which reaches
// them by the path it was already given.
const LEDGER_MAX = 20;

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
export async function limit<T>(p: Promise<T>, ms: number, onTimeout: Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout), ms);
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
  // Every file the conversation has carried, by name, in arrival order. Outside `Live` for
  // the same reason as `tail` — a child that dies mid-conversation is respawned and the
  // operator's files did not go anywhere — and the reason it exists at all is the ordinary
  // two-turn ticket: attach an image, ask for a Jira ticket, answer the assistant's
  // `ticket.questions`, and the turn that finally files the ticket is a turn with no
  // attachments of its own. Listing only that turn's files left the model with no name to
  // put in `jira.ticket.create.attachments`, so the ticket was filed without the image.
  private files = new Map<string, Map<string, ManagementTurnFile>>();

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
    // The ledger of names goes with the bytes: «новий чат» that still listed last
    // conversation's files would let the assistant name a file the operator can no longer
    // see, and the browser — whose own ledger reset with the transcript — would refuse it.
    this.files.delete(conversationId);
    // The conversation's document attachments die with it, live child or not: a file can
    // outlive a crashed child, and «новий чат» must not leave last chat's documents
    // behind. AWAITED, unlike drop()'s: reset is the one path a new ask on the same
    // conversation can legally follow at once, and its first attachment must not race a
    // removal still in flight.
    await rm(this.attachDir(conversationId), { recursive: true, force: true }).catch(() => {});
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
    // The operator's files, split by how the model reaches them: images ride the message
    // through omp's own image slots, documents land on disk so the read tool can open
    // them. Both are NAMED in the turn (see attachmentsBlock) — the names are also the
    // vocabulary of `jira.ticket.create.attachments`.
    const { images, files } = await this.storeAttachments(key, input.attachments ?? []);
    const message = buildManagementTurn({
      first,
      repos,
      context: input.context,
      today: todayIso(),
      text: helped.text,
      locale: input.locale,
      ...(files.length ? { attachments: files } : {}),
    });
    const { events, notices } = await this.drive(key, live, message, images);
    // First, because it describes the message that produced everything after it.
    if (helped.used.length) notices.unshift(helperNotice(helped.used));

    // The reduction is the supervisor's, not a second copy of it: the same events that
    // build a session transcript build this reply, so an omp frame that changes meaning
    // changes meaning in one place.
    const { entries } = reduceRpcEvents(events);
    const texts: string[] = [];
    for (const e of entries) {
      if (e.kind === "assistant_text") texts.push(e.text);
      else if (e.kind === "notice")
        notices.push({ text: e.text, ...(e.code ? { code: e.code } : {}), ...(e.params ? { params: e.params } : {}) });
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
      throw err;
    }
    this.map.set(key, live);
    this.log.debug(`management chat ${key}: omp запущено в ${cwd}`);
    return live;
  }

  // Send one message and wait out the turn it starts.
  private async drive(
    key: string,
    live: Live,
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
          // the prompt's rule (г) exists to stop it happening twice.
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
      const seconds = Math.round(TURN_TIMEOUT_MS / 1000);
      await limit(
        promise,
        TURN_TIMEOUT_MS,
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
    // Silent loss is the one failure this chat must never present as a complete answer.
    if (lost > 0)
      notices.push({
        text: `втрачено ${lost} кадр(ів) від omp — частина відповіді могла не дійти`,
        code: "frames_lost",
        params: { count: lost },
      });
    return { events, notices };
  }

  private drop(key: string): void {
    // Same best-effort cleanup as reset: the documents are as disposable as the child, and
    // the names go with them — an evicted conversation starts its next turn as a new one.
    void rm(this.attachDir(key), { recursive: true, force: true }).catch(() => {});
    this.files.delete(key);
    const live = this.map.get(key);
    if (!live) return;
    this.map.delete(key);
    live.turn = undefined;
    void live.rpc.stop().catch(() => {});
  }

  // ── Attachments on disk ──────────────────────────────────────────────────────

  // One directory per conversation under the OS temp dir. The key is sanitised into a
  // flat name (`management:<uuid>` → `management-<uuid>`), so no client-supplied string
  // ever becomes a path segment.
  private attachDir(key: string): string {
    return join(tmpdir(), "kermanych-management", key.replace(/[^A-Za-z0-9._-]/g, "-"));
  }

  // Persist the turn's documents, split out the images, and return every file the
  // conversation has carried: THIS message's first, then the earlier ones marked as such.
  // Documents accumulate on disk for the life of the conversation — the model may come back
  // to turn one's document on turn nine — and a re-attached name overwrites both the bytes
  // and its place in the ledger, which is what «here is the newer version» means.
  private async storeAttachments(
    key: string,
    attachments: ManagementAttachment[],
  ): Promise<{ images: ImageInput[]; files: ManagementTurnFile[] }> {
    const images: ImageInput[] = [];
    const fresh: ManagementTurnFile[] = [];
    const dir = this.attachDir(key);
    for (const a of attachments) {
      if (a.mimeType.startsWith("image/")) {
        images.push({ data: a.data, mimeType: a.mimeType });
        fresh.push({ name: a.name });
        continue;
      }
      // The name is display text from the browser; flattened to one safe segment so it can
      // never climb out of the conversation's directory.
      const safe = a.name.replace(/[/\\]/g, "-").replace(/^\.+/, "") || "file";
      const path = join(dir, safe);
      const bytes = Buffer.from(a.data, "base64");
      // mkdir per file, and one retry through a fresh mkdir: drop() removes this directory
      // fire-and-forget, so a removal from a just-dropped child may still be sweeping while
      // this turn writes. Losing that race must cost a retry, not the operator's file.
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(path, bytes);
      } catch {
        await mkdir(dir, { recursive: true });
        await writeFile(path, bytes);
      }
      fresh.push({ name: a.name, path });
    }
    const ledger = this.files.get(key) ?? new Map<string, ManagementTurnFile>();
    for (const f of fresh) {
      // Deleted before set so a re-attached name moves to the END of the ledger: the cap
      // below drops the oldest, and the file the operator just sent is never the oldest.
      ledger.delete(f.name);
      ledger.set(f.name, f);
    }
    while (ledger.size > LEDGER_MAX) {
      const oldest = ledger.keys().next();
      if (oldest.done === true) break;
      ledger.delete(oldest.value);
    }
    if (ledger.size > 0) this.files.set(key, ledger);
    // `earlier` is set on a COPY: the ledger holds how the file arrived, and the flag is a
    // statement about this turn only — the same entry is «this message» exactly once.
    const earlier: ManagementTurnFile[] = [];
    for (const f of ledger.values()) if (!fresh.some((n) => n.name === f.name)) earlier.push({ ...f, earlier: true });
    return { images, files: [...fresh, ...earlier] };
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
