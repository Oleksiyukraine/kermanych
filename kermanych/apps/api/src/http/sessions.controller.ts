// apps/api/src/http/sessions.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import type { ImageInput, RpcExtensionUIResponse } from "@kermanych/core";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";

@Controller("sessions")
export class SessionsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
  ) {}

  @Get()
  list(@Query("groupId") groupId?: string) {
    return this.reg.listSessions(groupId);
  }

  @Post()
  async create(@Body() b: { groupId: string; name: string; task: string; model?: string; images?: ImageInput[] }) {
    try {
      return await this.sup.createSession(b.groupId, b.name, b.task, b.model, b.images);
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

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.sup.deleteSession(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }
}
