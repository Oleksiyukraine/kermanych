import { AccountController } from "./http/account.controller";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth/auth.controller";
import { ProjectsController } from "./http/projects.controller";
import { SessionsController } from "./http/sessions.controller";
import { FsController } from "./http/fs.controller";
import { UsageController } from "./http/usage.controller";
import { SkillsController } from "./http/skills.controller";
import { ManagementController } from "./http/management.controller";
import { ModelsController } from "./http/models.controller";
import { RegistryService } from "./registry/registry.service";
import { WorktreeService } from "./worktree/worktree.service";
import { SupervisorService } from "./supervisor/supervisor.service";
import { EventsGateway } from "./ws/events.gateway";
import { PreviewService } from "./preview/preview.service";
import { EnvFileService } from "./env/env-file.service";
import { UsageService } from "./usage/usage.service";
import { AuthService } from "./auth/auth.service";
import { SupabaseAuthGuard } from "./auth/auth.guard";
import { CloudController } from "./cloud/cloud.controller";
import { CloudSyncService } from "./cloud/cloud-sync.service";
import { SkillsService } from "./skills/skills.service";
import { ManagementChatService } from "./management/management-chat.service";
import { ReleaseNotesService } from "./management/release-notes.service";
import { ModelsService } from "./models/models.service";
import { JiraController } from "./http/jira.controller";
import { JiraService } from "./jira/jira.service";

@Module({
  controllers: [AuthController, ProjectsController, SessionsController, FsController, UsageController, CloudController, SkillsController, ManagementController, ModelsController, JiraController, AccountController],
  providers: [
    RegistryService, WorktreeService, SupervisorService, PreviewService, EnvFileService, EventsGateway,
    UsageService,
    AuthService,
    SkillsService,
    // The local omp model catalog (`omp models --json`), read by GET /models and by the
    // supervisor when a running session's model is changed by provider + id.
    ModelsService,
    // The Менеджмент assistant. Depends on RegistryService alone: it resolves the scoped
    // workspace's local repo paths and drives its own omp children, and it deliberately
    // knows nothing about SupervisorService — this chat has no session, branch or worktree.
    ManagementChatService,
    // The Release Notes generator: one one-shot omp child per request, reading the bound
    // repo's git history through { RegistryService, WorktreeService }. Like the chat it
    // knows nothing about SupervisorService — a generation has no session and no worktree.
    ReleaseNotesService,
    // Dependency direction, stated once: CloudSyncService → { SupervisorService,
    // RegistryService, AuthService }. The supervisor never knows the mirror exists — it is
    // a pure `events$` subscriber, like EventsGateway.
    CloudSyncService,
    // The Jira integration engine: per-user tokens (RegistryService), Jira HTTP under the
    // acting user, mirror writes under their JWT (AuthService.cloudClient), and the launch
    // path reusing SupervisorService.createSessionFromTask unchanged.
    JiraService,
    // Global by design: the api binds 127.0.0.1 but was previously drivable by
    // anything on the machine, including GET /fs/list (arbitrary local directory
    // enumeration). Opt out per route with @Public(), never per module.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
})
export class AppModule {}
