import { Module } from "@nestjs/common";
import { GroupsController } from "./http/groups.controller";
import { SessionsController } from "./http/sessions.controller";
import { FsController } from "./http/fs.controller";
import { RegistryService } from "./registry/registry.service";
import { WorktreeService } from "./worktree/worktree.service";
import { SupervisorService } from "./supervisor/supervisor.service";
import { EventsGateway } from "./ws/events.gateway";
import { PreviewService } from "./preview/preview.service";

@Module({
  controllers: [GroupsController, SessionsController, FsController],
  providers: [RegistryService, WorktreeService, SupervisorService, PreviewService, EventsGateway],
})
export class AppModule {}
