// apps/api/src/http/schedules.controller.ts
// «Задачі за розкладом» over REST (docs/specs/2026-11-06-scheduled-tasks.md): the list and its
// edits, «Запустити зараз», the run history, and the local slips of «Центр сповіщень» (decision
// 6). Auto-guarded by the global SupabaseAuthGuard like every route; the tasks themselves are
// this machine's (decision 1). A refusal is a 400 whose body is core's rejection as
// `{ message, code, params }`, so the UI localizes it like any other.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import {
  validateScheduleDraft,
  validateSchedulePatch,
  type ManagementRejection,
  type ScheduledTask,
  type ScheduleRun,
  type ScheduleSlip,
} from "@kermanych/core";
import { ScheduleNotFound, ScheduleRefusal, ScheduleService } from "../schedules/schedule.service";
import { RegistryService } from "../registry/registry.service";

function refuse(r: ManagementRejection): BadRequestException {
  return new BadRequestException({ message: r.text, code: r.code, ...(r.params && Object.keys(r.params).length ? { params: r.params } : {}) });
}

// The service's own refusals and misses, as HTTP.
function relay(err: unknown): never {
  if (err instanceof ScheduleRefusal) throw refuse(err.rejection);
  if (err instanceof ScheduleNotFound) throw new NotFoundException(err.message);
  throw err;
}

@Controller("schedules")
export class SchedulesController {
  constructor(
    private schedules: ScheduleService,
    private registry: RegistryService,
  ) {}

  @Get()
  list(): { tasks: ScheduledTask[] } {
    return { tasks: this.schedules.list() };
  }

  @Post()
  async create(@Body() b: unknown): Promise<ScheduledTask> {
    const draft = validateScheduleDraft(b);
    if ("error" in draft) throw refuse(draft.error);
    try {
      return await this.schedules.create(draft);
    } catch (err) {
      relay(err);
    }
  }

  // The slips' routes come before `:id`, so «slips» is never read as a task id.
  @Get("slips")
  slips(): { slips: ScheduleSlip[] } {
    return { slips: this.schedules.slips() };
  }

  @Post("slips/seen")
  @HttpCode(200)
  seen(@Body() b: { ids?: unknown }): { ok: true } {
    const ids = b?.ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))) throw new BadRequestException("ids must be a list of slip ids");
    this.schedules.markSeen(ids as string[] | undefined);
    return { ok: true };
  }

  @Post("slips/:id/snooze")
  @HttpCode(200)
  snooze(@Param("id") id: string, @Body() b: { minutes?: unknown }): { ok: true } {
    if (b?.minutes !== 10 && b?.minutes !== 60) throw new BadRequestException("minutes must be 10 or 60");
    try {
      this.schedules.snooze(id, b.minutes);
    } catch (err) {
      relay(err);
    }
    return { ok: true };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() b: unknown): Promise<ScheduledTask> {
    const cur = this.registry.getSchedule(id);
    if (!cur) throw new NotFoundException("schedule not found");
    const patch = validateSchedulePatch(b, cur.kind);
    if ("error" in patch) throw refuse(patch.error);
    try {
      return await this.schedules.update(id, patch);
    } catch (err) {
      relay(err);
    }
  }

  @Delete(":id")
  remove(@Param("id") id: string): { ok: true } {
    try {
      this.schedules.remove(id);
    } catch (err) {
      relay(err);
    }
    return { ok: true };
  }

  @Post(":id/run")
  @HttpCode(200)
  async run(@Param("id") id: string): Promise<{ run: ScheduleRun }> {
    try {
      return { run: await this.schedules.runNow(id) };
    } catch (err) {
      relay(err);
    }
  }

  @Get(":id/runs")
  runs(@Param("id") id: string): { runs: ScheduleRun[] } {
    try {
      return { runs: this.schedules.runs(id) };
    } catch (err) {
      relay(err);
    }
  }
}
