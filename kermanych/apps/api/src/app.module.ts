import { Module } from "@nestjs/common";
import { GroupsController } from "./http/groups.controller";
import { SessionsController } from "./http/sessions.controller";
import { RegistryService } from "./registry/registry.service";
import { WorktreeService } from "./worktree/worktree.service";
import { SupervisorService } from "./supervisor/supervisor.service";
import { EventsGateway } from "./ws/events.gateway";

@Module({
  controllers: [GroupsController, SessionsController],
  providers: [RegistryService, WorktreeService, SupervisorService, EventsGateway],
})
export class AppModule {}
