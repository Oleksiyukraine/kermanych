// apps/api/src/http/management.controller.ts
import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import {
  isRiskCategory,
  isRiskKind,
  isRiskResponse,
  isRiskStatus,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ManagementContext,
  type ManagementRiskRow,
} from "@kermanych/core";
import { ManagementChatService } from "../management/management-chat.service";

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

// The Менеджмент assistant, over REST rather than the sessions WebSocket: one question,
// one answer, no board row and no live transcript to stream. Auto-guarded by the global
// SupabaseAuthGuard (app.module.ts), so there is no @Public() here — the chat spends the
// operator's own provider plan and must not be drivable by anything else on the machine.
@Controller("management")
export class ManagementController {
  constructor(private chat: ManagementChatService) {}

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
    const context: ManagementContext = {
      workspaceName: typeof b.context.workspaceName === "string" ? b.context.workspaceName : "",
      section: typeof b.context.section === "string" ? b.context.section : "",
      risks: riskRows(b.context.risks),
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
}
