// apps/api/src/http/routines.controller.ts
// The one routine call the UI makes to the local api (docs/specs/2026-10-16-routines.md):
// «Run now». Creating, editing, pausing and deleting a routine are cloud writes the browser
// makes under the member's JWT, like every Менеджмент section; only RUNNING one needs this
// machine — its checkouts, its Slack token, its agent runtime.
//
// The acting member comes from the guard (`req.user.id`), never the body: it decides whose
// routine may run here, and only its author's may.
import { BadRequestException, Controller, Param, Post, Req } from "@nestjs/common";
import type { WorkspaceRoutineRun } from "@kermanych/cloud";
import { RoutinesService } from "../routines/routines.service";

type Authed = { user: { id: string } };

@Controller("routines")
export class RoutinesController {
  constructor(private routines: RoutinesService) {}

  // Answers the claimed run at once (status `running`); the work continues in the background
  // and its end reaches the UI as a `routine_run` event.
  @Post(":id/run")
  async run(@Param("id") id: string, @Req() req: Authed): Promise<WorkspaceRoutineRun> {
    try {
      return await this.routines.runNow(id, req.user.id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
