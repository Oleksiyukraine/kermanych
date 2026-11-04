// apps/api/src/management/management-chat.service.ts
// The Менеджмент assistant: one `omp --mode rpc` child per conversation, driven turn by
// turn over the same binary, provider account and subscription every agent uses — so a
// question asked here is debited exactly where an agent's work is debited, and the reply
// says so (`usage`).
//
// The child mechanics — the per-conversation queue, spawn, timeouts, eviction, the event
// loop — are the shared chat pool's (../assistant/rpc-chat-pool.ts), which ЦУК runs on too.
// What is this assistant's own is layered on top: the read-only file tools, the attachments
// ledger on disk, the Jira tools over MCP, and the documentation child.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
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
import { RegistryService } from "../registry/registry.service";
import { ManagementMcpService } from "./management-mcp.service";
import { MachineResourcesService } from "../machine/machine-resources.service";
import type { JiraToolScope } from "../jira/jira-tools.service";
import { FAST_MODEL } from "../assistant/models";
import { RpcChatPool, readTurn, type ChatLaunch } from "../assistant/rpc-chat-pool";
import {
  buildManagementTurn,
  managementCwd,
  managementRepos,
  todayIso,
  type ManagementTurnFile,
} from "./management-prompt";

// Read-only on disk, and not a setting: a management chat that can write to the repository
// is a different — and far more dangerous — product than one that reads it to answer about
// risks. The same subset the quick chats run with (supervisor.service.ts CHAT_TOOLS), which is
// the existing proof that omp is happy in a bare project directory with no git and no edit
// tools. Jira is the one thing it WRITES, and only through the Jira tools the child is handed
// over MCP (management-mcp.service.ts), never through a file tool.
export const MANAGEMENT_TOOLS = ["read", "grep", "glob"] as const;

// The name the Jira tool server is given in the child. claude shows the tools as
// `mcp__kermanych__jira_*`; omp shows them bare (`jira_*`).
const MCP_SERVER_NAME = "kermanych";

// Documentation turns answer from passages the browser retrieved before the turn, and the
// docs protocol forbids them to go looking for more — so there is no exploration left to
// reason about, only prose to write from fragments already chosen. That is decode-bound
// work, so it runs on the fast model (../assistant/models.ts). Every other section keeps
// omp's default model, because a question about risk or capacity is exactly the kind that
// deserves the stronger one.
const DOCS_SECTION = "management-docs";

// Documentation runs on its own child, inside the SAME conversation id the browser sent —
// the split is the api's business, not the ui's. `attachDir` sanitises every character
// outside [A-Za-z0-9._-], so this suffix becomes its own directory rather than colliding
// with the main child's.
const DOCS_KEY_SUFFIX = "#docs";

function childKey(conversationId: string, section: string | undefined): string {
  return section === DOCS_SECTION ? `${conversationId}${DOCS_KEY_SUFFIX}` : conversationId;
}

// A legitimate turn here can grep three repositories before it answers: each tool round
// trip is a provider call plus disk work, and five of them at ten seconds each is a normal
// — not a broken — answer about the state of a workspace. Four minutes is the first number
// that cannot be reached by honest work, so hitting it means the child is stuck, and the
// child is dropped rather than retried.
const TURN_TIMEOUT_MS = 240_000;

// How many of a conversation's file names one turn carries. The block is a reminder, not
// an archive: ten files per message is the controller's own cap, and a chat that has
// exchanged dozens is one where the oldest names are no longer what «прикріпи файл» means.
// Only the LIST is trimmed — the documents stay on disk for the read tool, which reaches
// them by the path it was already given.
const LEDGER_MAX = 20;

// One file of the conversation as the api holds it: the prompt's view of it, plus where its
// bytes are and what they are — the Jira tools upload from here. Images are on disk too (the
// prompt still names them without a path: the model sees them through the image slots).
type StoredFile = ManagementTurnFile & { stored: string; mimeType: string };

// The Jira tools' scope for one child, mutated turn by turn: the acting user and workspace come
// with each ask, and `changed` points at the current turn's collector.
type ToolBinding = { token: string; scope: JiraToolScope; sink?: Notice[] };

@Injectable()
export class ManagementChatService implements OnModuleDestroy {
  // The children and their turn queue. Each child's `extra` is its Jira tool binding.
  private pool: RpcChatPool<ToolBinding>;
  // Every file the conversation has carried, by name, in arrival order. Outside the pool's
  // child for the same reason as the turn queue — a child that dies mid-conversation is
  // respawned and the operator's files did not go anywhere — and the reason it exists at all
  // is the ordinary two-turn ticket: attach an image, ask for a Jira ticket, answer the
  // assistant's `ticket.questions`, and the turn that finally files the ticket is a turn with
  // no attachments of its own. The Jira tools upload from this ledger by name, so a file must
  // still be here the turn the ticket is finally filed.
  private files = new Map<string, Map<string, StoredFile>>();

  constructor(
    private registry: RegistryService,
    // Both optional so a spec can build the chat without an http server: a child spawned
    // without them simply has no Jira tools, which the prompt's board lines still describe.
    @Optional() private mcp?: ManagementMcpService,
    @Optional() private http?: HttpAdapterHost,
    // The machine resource profile lowers this child's priority like every agent's
    // (docs/specs/2026-10-21-machine-resource-profile.md, decision 6). Optional for specs.
    @Optional() resources?: MachineResourcesService,
  ) {
    this.pool = new RpcChatPool<ToolBinding>({
      label: "management chat",
      turnTimeoutMs: TURN_TIMEOUT_MS,
      registry,
      ...(resources ? { resources } : {}),
      release: (tools) => this.mcp?.close(tools.token),
      // Same best-effort cleanup as reset: the documents are as disposable as the child, and
      // the names go with them — an evicted conversation starts its next turn as a new one.
      onDrop: (key) => {
        void rm(this.attachDir(key), { recursive: true, force: true }).catch(() => {});
        void rm(this.jiraDir(key), { recursive: true, force: true }).catch(() => {});
        this.files.delete(key);
      },
    });
  }

  // `userId` is the guard's, never the body's (the jira controller's rule): it decides whose
  // Jira token every tool call of this turn is signed with.
  async ask(input: ManagementChatAsk, userId: string): Promise<ManagementChatReply> {
    const startedAt = Date.now();
    this.pool.sweep();
    // A workspace whose projects are all unbound on this machine — or which holds none at
    // all — still gets a working chat: `managementRepos` drops the ids the registry does not
    // know and `managementCwd` then falls back to `homedir()`. The assistant's subject is
    // the management surface, not the source, so there is nothing to refuse here.
    const repos = managementRepos(this.registry.listProjects(), input.workspaceProjects);
    const key = childKey(input.conversationId, input.context?.section);
    return this.pool.enqueue(key, () => this.turn(key, repos, input, userId, startedAt));
  }

  // «Новий чат» has to mean it — see RpcChatPool.reset.
  async reset(conversationId: string): Promise<{ ok: true }> {
    this.pool.sweep();
    // BOTH children, because the conversation the operator is discarding is spread across
    // them: documentation runs on its own child under the `#docs` key. Sparing it would
    // answer the next question in the light of what was just thrown away, invisibly.
    await this.resetOne(conversationId);
    await this.resetOne(`${conversationId}${DOCS_KEY_SUFFIX}`);
    return { ok: true };
  }

  private async resetOne(key: string): Promise<void> {
    await this.pool.reset(key, async () => {
      // The ledger of names goes with the bytes: «новий чат» that still listed last
      // conversation's files would let the assistant name a file the operator can no longer
      // see, and the browser — whose own ledger reset with the transcript — would refuse it.
      this.files.delete(key);
      // The conversation's document attachments die with it, live child or not: a file can
      // outlive a crashed child, and «новий чат» must not leave last chat's documents
      // behind. AWAITED, unlike drop()'s: reset is the one path a new ask on the same
      // conversation can legally follow at once, and its first attachment must not race a
      // removal still in flight.
      await rm(this.attachDir(key), { recursive: true, force: true }).catch(() => {});
      await rm(this.jiraDir(key), { recursive: true, force: true }).catch(() => {});
    });
  }

  onModuleDestroy(): void {
    this.pool.dropAll();
  }

  private async turn(
    key: string,
    repos: ManagementRepo[],
    input: ManagementChatAsk,
    userId: string,
    startedAt: number,
  ): Promise<ManagementChatReply> {
    const docs = input.context?.section === DOCS_SECTION;
    const live = await this.pool.child(key, () => this.launch(key, repos, docs ? FAST_MODEL : undefined, !docs));
    // Re-pointed every turn: the child outlives any one ask, and the tools must act for the
    // operator and workspace of THIS one and report into THIS reply.
    const jiraChanges: Notice[] = [];
    const tools = live.extra;
    if (tools) {
      tools.scope.userId = userId;
      tools.scope.workspaceId = input.workspaceId;
      tools.sink = jiraChanges;
    }
    const first = !live.greeted;
    // Хелпери are expanded HERE rather than inside buildManagementTurn: that function wraps
    // the operator's text in the contract and the context markers, so by the time the child
    // reads it a leading `/el10` is no longer leading and would expand nowhere.
    const helped = expandHelpers(input.text);
    // The operator's files, split by how the model reaches them: images ride the message
    // through omp's own image slots, documents are opened by the read tool. Both are NAMED
    // in the turn (see attachmentsBlock) — the names are also what the Jira tools upload by.
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
    let events: RpcEvent[];
    let notices: Notice[];
    try {
      ({ events, notices } = await this.pool.drive(key, live, message, images));
    } finally {
      // A tool call still in flight after the turn ended (timeout) reports nowhere.
      if (tools) tools.sink = undefined;
    }
    // First, because it describes the message that produced everything after it.
    if (helped.used.length) notices.unshift(helperNotice(helped.used));
    const { raw, usage, model } = readTurn(events, notices, startedAt);
    const parsed = parseManagementReply(raw);
    return {
      text: parsed.text,
      actions: parsed.actions,
      rejected: parsed.rejected,
      notices,
      jiraChanges,
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it — the queue wait and the spawn included,
      // because that is what they sat through.
      ms: Date.now() - startedAt,
    };
  }

  // What a new child of this conversation is launched with. Documentation turns answer from
  // retrieved passages only (docsProtocol) and never touch Jira, so their child gets no Jira
  // tools.
  private launch(key: string, repos: ManagementRepo[], model: string | undefined, withTools: boolean): ChatLaunch<ToolBinding> {
    const tools = withTools ? this.bindTools(key) : undefined;
    return {
      opts: {
        cwd: managementCwd(repos),
        tools: [...MANAGEMENT_TOOLS],
        ...(model ? { model } : {}),
        ...(tools ? { mcp: tools.mcp } : {}),
      },
      ...(tools ? { extra: tools.binding } : {}),
    };
  }

  // The Jira tools for one child: a fresh bearer secret bound to a scope this service keeps
  // pointing at the current turn. Absent when the api has no MCP service or no listening
  // http server to name (specs), in which case the child runs without them.
  private bindTools(key: string): { binding: ToolBinding; mcp: { name: string; url: string; token: string } } | undefined {
    const address = this.http?.httpAdapter?.getHttpServer()?.address() as { port?: number } | string | null | undefined;
    const port = address && typeof address === "object" ? address.port : undefined;
    if (!this.mcp || !port) return undefined;
    const binding: ToolBinding = {
      token: "",
      scope: {
        userId: "",
        workspaceId: "",
        file: (name) => {
          const f = this.files.get(key)?.get(name.trim());
          return f ? { path: f.stored, mimeType: f.mimeType } : undefined;
        },
        downloadDir: this.jiraDir(key),
        changed: (n) => binding.sink?.push(n),
      },
    };
    binding.token = this.mcp.open(binding.scope);
    return { binding, mcp: { name: MCP_SERVER_NAME, url: `http://127.0.0.1:${port}/api/management/mcp`, token: binding.token } };
  }

  // ── Attachments on disk ──────────────────────────────────────────────────────

  // One directory per conversation under the OS temp dir. The key is sanitised into a
  // flat name (`management:<uuid>` → `management-<uuid>`), so no client-supplied string
  // ever becomes a path segment.
  private attachDir(key: string): string {
    return join(tmpdir(), "kermanych-management", key.replace(/[^A-Za-z0-9._-]/g, "-"));
  }

  // Persist the turn's files and return every file the conversation has carried: THIS
  // message's first, then the earlier ones marked as such. Every file lands on disk — the
  // Jira tools upload from there, images included — while images additionally ride the
  // message through the image slots, which is how the model SEES them (the prompt names
  // them without a path). Files accumulate for the life of the conversation — the model may
  // come back to turn one's document on turn nine — and a re-attached name overwrites both
  // the bytes and its place in the ledger, which is what «here is the newer version» means.
  private async storeAttachments(
    key: string,
    attachments: ManagementAttachment[],
  ): Promise<{ images: ImageInput[]; files: ManagementTurnFile[] }> {
    const images: ImageInput[] = [];
    const fresh: StoredFile[] = [];
    const dir = this.attachDir(key);
    for (const a of attachments) {
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
      const image = a.mimeType.startsWith("image/");
      if (image) images.push({ data: a.data, mimeType: a.mimeType });
      fresh.push({ name: a.name, ...(image ? {} : { path }), stored: path, mimeType: a.mimeType });
    }
    const ledger = this.files.get(key) ?? new Map<string, StoredFile>();
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
    // The prompt's view only: where the bytes are stored is the tools' business. `earlier`
    // is a statement about this turn, so the ledger itself never carries it.
    const view = (f: StoredFile, earlier: boolean): ManagementTurnFile => ({
      name: f.name,
      ...(f.path !== undefined ? { path: f.path } : {}),
      ...(earlier ? { earlier: true } : {}),
    });
    const earlier: ManagementTurnFile[] = [];
    for (const f of ledger.values()) if (!fresh.some((n) => n.name === f.name)) earlier.push(view(f, true));
    return { images, files: [...fresh.map((f) => view(f, false)), ...earlier] };
  }

  // Where jira_download_attachment writes for this conversation. A root of its own rather
  // than a subdirectory of `attachDir`: an operator's document may be called anything, and a
  // file named like this directory must not be able to shadow it. Same sanitised key, so no
  // client string becomes a path segment.
  private jiraDir(key: string): string {
    return join(tmpdir(), "kermanych-management-jira", key.replace(/[^A-Za-z0-9._-]/g, "-"));
  }
}
