// apps/api/src/http/sessions.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { BranchPrefix, ImageInput, Platform, RpcExtensionUIResponse, TaskDraft } from "@kermanych/core";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";
import { PreviewService } from "../preview/preview.service";

@Controller("sessions")
export class SessionsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private preview: PreviewService,
  ) {}

  @Get()
  list(@Query("projectId") projectId?: string) {
    return this.reg.listSessions(projectId);
  }

  @Post()
  async create(
    @Body()
    b: { projectId: string; name: string; task: string; model?: string; images?: ImageInput[]; worktree?: boolean; prefix?: BranchPrefix; platform?: Platform; asTask?: boolean; baseBranch?: string },
  ) {
    try {
      return await this.sup.createSession(b.projectId, b.name, b.task, b.model, b.images, b.worktree ?? true, b.prefix ?? "feature", b.asTask ?? false, b.platform, b.baseBranch);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post("chat")
  async createChat(@Body() b: { projectId: string }) {
    try {
      return await this.sup.createChat(b.projectId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // A literal segment, so it MUST be declared above the `:id` block — Nest matches in
  // declaration order and `:id/...` would otherwise swallow `from-task` (same reason
  // `@Post("chat")` sits above `@Post(":id/start")`).
  // The task id is the ONLY identity input: who may run it comes from the guard's cached
  // token, never from the request body. `images` are the first prompt's attachments; they
  // stay on this machine and never reach the cloud.
  @Post("from-task")
  async createFromTask(@Body() b: { taskId: string; images?: ImageInput[] }, @Req() req: { user: { id: string } }) {
    try {
      return await this.sup.createSessionFromTask(b.taskId, req.user.id, b.images);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/start")
  async start(
    @Param("id") id: string,
    @Body() b: TaskDraft & { images?: ImageInput[] },
  ) {
    try {
      const { images, ...draft } = b;
      return await this.sup.startTask(id, draft, images);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // No body: a chat carries everything the promotion needs (its conversation, its opening ask).
  @Post(":id/promote")
  async promote(@Param("id") id: string) {
    try {
      return await this.sup.promoteChatToAgent(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() b: TaskDraft,
  ) {
    try {
      return this.sup.updateTask(id, b);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/move")
  move(@Param("id") id: string, @Body() b: { projectId: string }) {
    try {
      return this.sup.moveTask(id, b.projectId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/message")
  async message(@Param("id") id: string, @Body() b: { text: string; mode: "prompt" | "follow_up" | "steer"; images?: ImageInput[] }) {
    try {
      return await this.sup.sendMessage(id, b.text, b.mode, b.images);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/branch")
  async branch(@Param("id") id: string) {
    try {
      return await this.sup.branchSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/review")
  async review(@Param("id") id: string) {
    try {
      return await this.sup.reviewSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/merge")
  async merge(@Param("id") id: string, @Body() b: { summary?: string }) {
    try {
      return await this.sup.mergeDiscussion(id, b.summary);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/answer")
  answer(@Param("id") id: string, @Body() b: { res: RpcExtensionUIResponse }) {
    try {
      return this.sup.answerUi(id, b.res);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/stop")
  async stop(@Param("id") id: string) {
    try {
      await this.sup.stopSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }

  @Get(":id/transcript")
  transcript(@Param("id") id: string) {
    return this.sup.getTranscript(id);
  }

  // Deliberately unwrapped: the `try/catch → BadRequestException` the @Post siblings use would
  // swallow the service's GoneException and turn the 410 into a 400, collapsing the UI's
  // "output expired" branch into a generic error.
  @Get(":id/tools/:callId")
  toolDetail(@Param("id") id: string, @Param("callId") callId: string) {
    return this.sup.getToolDetail(id, callId);
  }

  @Post(":id/preview")
  async startPreview(@Param("id") id: string) {
    try {
      return await this.preview.start(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Delete(":id/preview")
  stopPreview(@Param("id") id: string) {
    this.preview.stop(id);
    return { ok: true };
  }

  @Get(":id/finish")
  async finishInfo(@Param("id") id: string) {
    try {
      return await this.sup.finishInfo(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // A read, so GET; the path rides in the query, where its slashes need no route gymnastics.
  @Get(":id/diff")
  async fileDiff(@Param("id") id: string, @Query("path") path?: string) {
    try {
      return await this.sup.fileDiff(id, path ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/finish")
  async finish(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      return await this.sup.finishSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/pr")
  async pr(@Param("id") id: string) {
    try {
      return await this.sup.createPullRequest(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/archive")
  archive(@Param("id") id: string) {
    try {
      this.sup.setArchived(id, true);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }

  @Post(":id/unarchive")
  unarchive(@Param("id") id: string) {
    try {
      this.sup.setArchived(id, false);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }

  @Post(":id/editor")
  openEditor(@Param("id") id: string) {
    try {
      return this.sup.openInEditor(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/resolve")
  async resolve(@Param("id") id: string) {
    try {
      return await this.sup.resolveConflict(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // Non-destructive counterpart to :id/restart — wakes a dormant session so its transcript
  // rehydrates, and leaves a live one (and its running turn) alone.
  @Post(":id/resume")
  async resume(@Param("id") id: string) {
    try {
      return await this.sup.resume(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/restart")
  async restart(@Param("id") id: string) {
    try {
      return await this.sup.restartSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/reopen")
  async reopen(@Param("id") id: string) {
    try {
      return await this.sup.reopenSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      await this.sup.deleteSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }
}
