// apps/api/src/http/management.controller.ts
import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import type { ManagementChatAsk, ManagementChatReply } from "@kermanych/core";
import { ManagementChatService } from "../management/management-chat.service";

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
    try {
      return await this.chat.ask({ ...b, conversationId, text, workspaceId, workspaceProjects });
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
