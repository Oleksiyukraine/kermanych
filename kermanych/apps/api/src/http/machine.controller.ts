import { BadRequestException, Body, Controller, Get, Post, Put } from "@nestjs/common";
import { parseLimitsPatch, type MachineResources, type ResourcesUpdate } from "@kermanych/core";
import { MachineResourcesService } from "../machine/machine-resources.service";
import { WatchdogService } from "../machine/watchdog.service";
import { SupervisorService } from "../supervisor/supervisor.service";

// This machine's resource profile (docs/specs/2026-10-21-machine-resource-profile.md): the
// consent popup and Settings → «Ресурси машини» read and write it here. Machine-local by
// design, like the outbox: one user's second machine has its own hardware.
@Controller("machine")
export class MachineController {
  constructor(
    private resources: MachineResourcesService,
    private watchdog: WatchdogService,
    private supervisor: SupervisorService,
  ) {}

  @Get("resources")
  get(): Promise<MachineResources> {
    return this.resources.snapshot(this.supervisor.slotCounts());
  }

  @Put("resources")
  update(@Body() b: { decision?: unknown; overrides?: unknown }): Promise<MachineResources> {
    const u: ResourcesUpdate = {};
    if (b?.decision !== undefined) {
      if (b.decision !== "applied" && b.decision !== "declined") throw new BadRequestException(`unknown decision ${JSON.stringify(b.decision)}`);
      u.decision = b.decision;
    }
    if (b?.overrides === null) u.overrides = null;
    else if (b?.overrides !== undefined) {
      const parsed = parseLimitsPatch(b.overrides);
      if (!parsed.ok) throw new BadRequestException(`invalid resource limit ${JSON.stringify(parsed.key)}`);
      u.overrides = parsed.patch;
    }
    this.resources.update(u);
    return this.resources.snapshot(this.supervisor.slotCounts());
  }

  @Post("resources/redetect")
  redetect(): Promise<MachineResources> {
    this.resources.redetect();
    return this.resources.snapshot(this.supervisor.slotCounts());
  }

  // «Зупинити команду» on a watchdog notice. `ok: false` when that command is already gone or
  // is not one the session started after it became ready.
  @Post("kill")
  async kill(@Body() b: { sessionId?: unknown; pid?: unknown }): Promise<{ ok: boolean }> {
    if (typeof b?.sessionId !== "string" || !b.sessionId) throw new BadRequestException("sessionId is required");
    if (typeof b.pid !== "number" || !Number.isInteger(b.pid) || b.pid <= 0) throw new BadRequestException("pid must be a positive integer");
    return { ok: await this.watchdog.kill(b.sessionId, b.pid) };
  }
}
