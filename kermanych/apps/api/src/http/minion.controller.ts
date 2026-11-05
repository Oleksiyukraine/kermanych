import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Put } from "@nestjs/common";
import { clampMinionCap, type MinionState } from "@kermanych/core";
import { MinionService } from "../minion/minion.service";

// «Посіпака» on this machine (docs/specs/2026-10-23-minion-auto-run.md, decisions 6, 8, 12): the
// «ШІ-команда» card and the map strip read and change it here. Machine-local by design, like
// «Ресурси машини»: whether a machine may work alone depends on that machine.
@Controller("minion")
export class MinionController {
  constructor(private minion: MinionService) {}

  @Get()
  get(): MinionState {
    return this.minion.state();
  }

  @Put()
  update(@Body() b: { cap?: unknown; paused?: unknown }): MinionState {
    const cap = b?.cap === undefined ? undefined : clampMinionCap(b.cap);
    if (b?.cap !== undefined && cap === undefined) throw new BadRequestException(`invalid cap ${JSON.stringify(b.cap)}`);
    if (b?.paused !== undefined && typeof b.paused !== "boolean") throw new BadRequestException("paused must be a boolean");
    return this.minion.update({ ...(cap !== undefined ? { cap } : {}), ...(typeof b?.paused === "boolean" ? { paused: b.paused } : {}) });
  }

  @Put("projects/:id")
  setProject(@Param("id") id: string, @Body() b: { active?: unknown }): MinionState {
    if (typeof b?.active !== "boolean") throw new BadRequestException("active must be a boolean");
    try {
      return this.minion.setProject(id, b.active);
    } catch (err) {
      const message = (err as Error).message;
      throw message === "project not found" ? new NotFoundException(message) : new BadRequestException(message);
    }
  }
}
