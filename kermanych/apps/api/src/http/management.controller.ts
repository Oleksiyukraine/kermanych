// apps/api/src/http/management.controller.ts
import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import {
  isReleaseDate,
  isRiskCategory,
  isRiskKind,
  isRiskResponse,
  isRiskStatus,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ManagementContext,
  type ManagementJiraBoard,
  type ManagementMember,
  type ManagementRiskRow,
  type ReleaseNotesAsk,
  type ReleaseNotesReply,
} from "@kermanych/core";
import { ManagementChatService } from "../management/management-chat.service";
import { ReleaseNotesService } from "../management/release-notes.service";

// The register as the browser sent it, kept only where every field is one this build knows.
// `project_risks` is behind RLS and the api has no credentials for it, so this list cannot be
// re-derived here — but a row with an invented category would be printed into the prompt as
// fact, and the assistant would then file more of them.
function riskRows(v: unknown): ManagementRiskRow[] {
  if (!Array.isArray(v)) return [];
  const rows: ManagementRiskRow[] = [];
  for (const r of v) {
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, unknown>;
    if (typeof x.code !== "string" || x.code === "") continue;
    if (!isRiskKind(x.kind) || !isRiskCategory(x.category) || !isRiskResponse(x.response) || !isRiskStatus(x.status))
      continue;
    if (typeof x.probability !== "number" || typeof x.impact !== "number") continue;
    rows.push({
      code: x.code,
      kind: x.kind,
      category: x.category,
      event: typeof x.event === "string" ? x.event : "",
      probability: x.probability,
      impact: x.impact,
      response: x.response,
      status: x.status,
    });
  }
  return rows;
}

// The roster as the browser sent it. Same reasoning as `riskRows`: `workspace_members` is
// behind RLS and the api has no credentials for it, so the list cannot be re-derived here —
// but it is printed into the prompt as the set of people a ticket may be assigned to, and a
// blank name there is an assignee the browser could never resolve back to a uuid.
function memberRows(v: unknown): ManagementMember[] {
  if (!Array.isArray(v)) return [];
  const rows: ManagementMember[] = [];
  for (const m of v) {
    if (typeof m !== "object" || m === null) continue;
    const x = m as Record<string, unknown>;
    if (typeof x.name !== "string" || x.name.trim() === "") continue;
    rows.push({ name: x.name.trim(), role: typeof x.role === "string" ? x.role : "" });
  }
  return rows;
}

// The workspace's Jira board, or nothing. `undefined` is a meaningful value here — the
// context block prints «не підключена» and the assistant then knows `jira.ticket.create` has
// nowhere to land — so a half-filled row is dropped rather than repaired: a board with no
// project key cannot be described to the model in any way it could act on.
function jiraBoard(v: unknown): ManagementJiraBoard | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.projectKey !== "string" || x.projectKey.trim() === "") return undefined;
  return {
    projectKey: x.projectKey.trim(),
    boardName: typeof x.boardName === "string" ? x.boardName : "",
    // Write capability is never assumed: absent means «не можу створити», which is the safe
    // way round — the assistant says so instead of promising a ticket the api cannot sign.
    canWrite: x.canWrite === true,
    // Jira's own assignable users, by display name. Read from the browser for `memberRows`'
    // reason inverted: the api COULD ask Jira itself, but the browser already holds the list
    // its ticket dialog renders, and a second fetch here would let the prompt name people
    // the operator's own picker does not show. Blank entries are dropped — a blank name is
    // an assignee nothing could resolve back to an accountId.
    assignees: Array.isArray(x.assignees)
      ? x.assignees.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())
      : [],
  };
}

// The Менеджмент assistant, over REST rather than the sessions WebSocket: one question,
// one answer, no board row and no live transcript to stream. Auto-guarded by the global
// SupabaseAuthGuard (app.module.ts), so there is no @Public() here — the chat spends the
// operator's own provider plan and must not be drivable by anything else on the machine.
@Controller("management")
export class ManagementController {
  constructor(
    private chat: ManagementChatService,
    private releases: ReleaseNotesService,
  ) {}

  @Post("chat")
  async ask(@Body() b: ManagementChatAsk): Promise<ManagementChatReply> {
    const conversationId = typeof b?.conversationId === "string" ? b.conversationId.trim() : "";
    if (!conversationId) throw new BadRequestException("не вказано розмову (conversationId)");
    const text = typeof b?.text === "string" ? b.text.trim() : "";
    // A blank turn would still spawn omp and still cost a provider call, for a question
    // nobody asked.
    if (!text) throw new BadRequestException("повідомлення порожнє");
    // The one scope check this endpoint makes, and it replaced a registry-binding refusal
    // that turned away a workspace none of whose repositories are bound on this machine.
    // The honest scope question at this level is «is a workspace named»: a named workspace
    // always has a subject — its risk register and the section table — even with nothing
    // bound here, and `managementCwd` documents that fallback to the home directory.
    // `ManagementChatService` reads the registry itself to resolve the repos it can name,
    // so dropping the old check lost nothing but a working chat it used to refuse.
    const workspaceId = typeof b?.workspaceId === "string" ? b.workspaceId.trim() : "";
    if (!workspaceId) throw new BadRequestException("не вказано воркспейс");
    // Only the two fields the browser is the authority on survive: the id, and the cloud
    // row's git remote. Anything else a client sent about a repository is ignored — the
    // paths come from this machine's registry and nowhere else.
    const workspaceProjects = Array.isArray(b?.workspaceProjects)
      ? b.workspaceProjects
          .filter((x): x is { id: string; gitRemoteUrl?: string } => !!x && typeof x.id === "string" && x.id !== "")
          .map((x) => ({ id: x.id, ...(typeof x.gitRemoteUrl === "string" && x.gitRemoteUrl !== "" ? { gitRemoteUrl: x.gitRemoteUrl } : {}) }))
      : [];
    if (!b?.context) throw new BadRequestException("не передано контекст розділу");
    // Rebuilt rather than forwarded: `risks` is printed into the prompt as the state the
    // write actions operate on, and the rest of the block is prose the model reads as fact.
    const jira = jiraBoard(b.context.jira);
    const context: ManagementContext = {
      workspaceName: typeof b.context.workspaceName === "string" ? b.context.workspaceName : "",
      section: typeof b.context.section === "string" ? b.context.section : "",
      risks: riskRows(b.context.risks),
      members: memberRows(b.context.members),
      ...(jira ? { jira } : {}),
    };
    try {
      return await this.chat.ask({ ...b, conversationId, text, workspaceId, workspaceProjects, context });
    } catch (err) {
      // A missing `omp`, a start timeout or a turn timeout are all operator-actionable
      // sentences already; a 500 would hide every one of them behind "Internal Server
      // Error" and the composer would have nothing to show.
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post("chat/reset")
  async reset(@Body() b: { conversationId?: string }): Promise<{ ok: true }> {
    const conversationId = typeof b?.conversationId === "string" ? b.conversationId.trim() : "";
    if (!conversationId) throw new BadRequestException("не вказано розмову (conversationId)");
    try {
      return await this.chat.reset(conversationId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // Generate — NOT store: the reply is a document the browser then saves into
  // `workspace_release_notes` under the operator's own JWT. Guarded like the chat, and for
  // the same reason: a generation spends the operator's provider plan.
  //
  // One browser caller — stores/release-notes.ts `generate` — reached two ways: the section
  // screen's form and the management assistant's `release.notes` action. The bounds below are
  // re-checked whoever asked: `isReleaseDate` is the same predicate @kermanych/core validates
  // that action with, so the chat refuses a bad range without a round trip and this endpoint
  // still refuses it if anything else asks.
  @Post("release-notes")
  async releaseNotes(@Body() b: ReleaseNotesAsk): Promise<ReleaseNotesReply> {
    const projectId = typeof b?.projectId === "string" ? b.projectId.trim() : "";
    if (!projectId) throw new BadRequestException("не вказано проєкт");
    const branch = typeof b?.branch === "string" ? b.branch.trim() : "";
    if (!branch) throw new BadRequestException("не вказано гілку");
    const rangeFrom = typeof b?.rangeFrom === "string" ? b.rangeFrom.trim() : "";
    const rangeTo = typeof b?.rangeTo === "string" ? b.rangeTo.trim() : "";
    if (!isReleaseDate(rangeFrom) || !isReleaseDate(rangeTo))
      throw new BadRequestException("період має бути парою дат у форматі YYYY-MM-DD");
    // Lexicographic IS chronological for YYYY-MM-DD — no Date parsing to disagree with git.
    if (rangeFrom > rangeTo) throw new BadRequestException("початок періоду пізніший за його кінець");
    const workspaceName = typeof b?.workspaceName === "string" ? b.workspaceName.trim() : "";
    try {
      return await this.releases.generate({ projectId, workspaceName, branch, rangeFrom, rangeTo });
    } catch (err) {
      // Unbound project, unknown branch, an empty range and a dead omp are all
      // operator-actionable sentences; a 500 would bury every one of them.
      throw new BadRequestException((err as Error).message);
    }
  }
}
