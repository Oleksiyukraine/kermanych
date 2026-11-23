import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put } from "@nestjs/common";
import { normalizePrLoopSettings, type PrLoopSettings, type PrLoopState } from "@kermanych/core";
import { PrLoopService } from "../pr-loop/pr-loop.service";

// An unknown session or project is a 404; everything else the loop refuses (busy, nothing to
// send, not watched) a 400 carrying its message.
function loopFailure(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return message === "session not found" || message === "project not found" ? new NotFoundException(message) : new BadRequestException(message);
}

// «Петля після ПР» (docs/specs/2026-11-23-pr-feedback-loop.md): the watched sessions' states, the
// operator's manual pass and «Продовжити петлю», and the per-project mode and round limit — machine
// local, like «Посіпака»'s switches.
@Controller()
export class PrLoopController {
  constructor(private loop: PrLoopService) {}

  @Get("pr-loop")
  list(): PrLoopState[] {
    return this.loop.list();
  }

  @Post("sessions/:id/pr-loop/send")
  async send(@Param("id") id: string, @Body() b: { keys?: unknown }): Promise<{ sent: true }> {
    const keys = b?.keys;
    if (keys !== undefined && (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")))
      throw new BadRequestException("keys must be an array of strings");
    try {
      return await this.loop.send(id, keys ?? []);
    } catch (err) {
      throw loopFailure(err);
    }
  }

  @Post("sessions/:id/pr-loop/resume")
  async resume(@Param("id") id: string): Promise<PrLoopState> {
    try {
      return await this.loop.resume(id);
    } catch (err) {
      throw loopFailure(err);
    }
  }

  @Get("projects/:id/pr-loop-settings")
  getSettings(@Param("id") id: string): PrLoopSettings {
    try {
      return this.loop.getSettings(id);
    } catch (err) {
      throw loopFailure(err);
    }
  }

  @Put("projects/:id/pr-loop-settings")
  setSettings(@Param("id") id: string, @Body() b: unknown): PrLoopSettings {
    let current: PrLoopSettings;
    try {
      current = this.loop.getSettings(id);
    } catch (err) {
      throw loopFailure(err);
    }
    const next = normalizePrLoopSettings(b, current);
    if (!next) throw new BadRequestException(`invalid pr loop settings ${JSON.stringify(b)}`);
    return this.loop.setSettings(id, next);
  }
}
