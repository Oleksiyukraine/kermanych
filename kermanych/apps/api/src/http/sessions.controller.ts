// apps/api/src/http/sessions.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import type { BranchPrefix, ImageInput, RpcExtensionUIResponse } from "@kermanych/core";
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
  list(@Query("groupId") groupId?: string) {
    return this.reg.listSessions(groupId);
  }

  @Post()
  async create(
    @Body()
    b: { groupId: string; name: string; task: string; model?: string; images?: ImageInput[]; worktree?: boolean; prefix?: BranchPrefix },
  ) {
    try {
      return await this.sup.createSession(b.groupId, b.name, b.task, b.model, b.images, b.worktree ?? true, b.prefix ?? "feature");
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

  @Post(":id/finish")
  async finish(@Param("id") id: string) {
    try {
      this.preview.stop(id);
      return await this.sup.finishSession(id);
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

  @Post(":id/restart")
  async restart(@Param("id") id: string) {
    try {
      return await this.sup.restartSession(id);
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
