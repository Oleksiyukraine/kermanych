import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth/auth.controller";
import { ProjectsController } from "./http/projects.controller";
import { SessionsController } from "./http/sessions.controller";
import { FsController } from "./http/fs.controller";
import { RegistryService } from "./registry/registry.service";
import { WorktreeService } from "./worktree/worktree.service";
import { SupervisorService } from "./supervisor/supervisor.service";
import { EventsGateway } from "./ws/events.gateway";
import { PreviewService } from "./preview/preview.service";
import { EnvFileService } from "./env/env-file.service";
import { AuthService } from "./auth/auth.service";
import { SupabaseAuthGuard } from "./auth/auth.guard";
import { CloudController } from "./cloud/cloud.controller";
import { CloudSyncService } from "./cloud/cloud-sync.service";

@Module({
  controllers: [AuthController, ProjectsController, SessionsController, FsController, CloudController],
  providers: [
    RegistryService, WorktreeService, SupervisorService, PreviewService, EnvFileService, EventsGateway,
    AuthService,
    // Dependency direction, stated once: CloudSyncService → { SupervisorService,
    // RegistryService, AuthService }. The supervisor never knows the mirror exists — it is
    // a pure `events$` subscriber, like EventsGateway.
    CloudSyncService,
    // Global by design: the api binds 127.0.0.1 but was previously drivable by
    // anything on the machine, including GET /fs/list (arbitrary local directory
    // enumeration). Opt out per route with @Public(), never per module.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
})
export class AppModule {}
