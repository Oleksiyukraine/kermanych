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
import { RuntimeCheckService } from "./runtime/runtime-check.service";
import { JiraController } from "./http/jira.controller";
import { JiraService } from "./jira/jira.service";
import { LinearController } from "./http/linear.controller";
import { LinearService } from "./linear/linear.service";
import { SlackController } from "./http/slack.controller";
import { SlackService } from "./slack/slack.service";
import { DocIndexService } from "./docs/doc-index.service";
import { DocsController } from "./http/docs.controller";
import { ManagementMcpController } from "./http/management-mcp.controller";
import { ManagementMcpService } from "./management/management-mcp.service";
import { JiraToolsService } from "./jira/jira-tools.service";
import { TerminalService } from "./terminal/terminal.service";
import { TerminalGateway } from "./ws/terminal.gateway";
import { NativeSessionService } from "./native/native-session.service";
import { NativeController } from "./http/native.controller";
import { BrowserMcpController } from "./http/browser-mcp.controller";
import { BrowserMcpService } from "./browser/browser-mcp.service";

@Module({
  controllers: [AuthController, ProjectsController, SessionsController, FsController, UsageController, CloudController, SkillsController, ManagementController, ManagementMcpController, ModelsController, JiraController, LinearController, SlackController, AccountController, DocsController, NativeController, BrowserMcpController],
  providers: [
    RegistryService, WorktreeService, SupervisorService, PreviewService, EnvFileService, EventsGateway,
    UsageService,
    AuthService,
    SkillsService,
    // The local omp model catalog (`omp models --json`), read by GET /models and by the
    // supervisor when a running session's model is changed by provider + id.
    ModelsService,
    // The "is this backend usable on this machine?" preflight behind GET
    // /account/runtime/check. Distinct from ModelsService on purpose: that one degrades every
    // failure to an empty catalog so a picker always renders, which is precisely the swallowing
    // this check exists to undo.
    RuntimeCheckService,
    // The Менеджмент assistant. Resolves the scoped workspace's local repo paths
    // (RegistryService), drives its own agent children, and hands each child the Jira tools
    // through ManagementMcpService. It deliberately knows nothing about SupervisorService —
    // this chat has no session, branch or worktree.
    ManagementChatService,
    // The assistant's live Jira tools (JiraToolsService, over JiraService under the acting
    // user's own token) served as MCP to the chat's children, one bearer secret per child.
    JiraToolsService,
    ManagementMcpService,
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
    // The Linear integration engine: the Jira precedent for GraphQL — per-user API keys
    // (RegistryService), Linear HTTP under the acting user, mirror writes under their JWT,
    // and the same SupervisorService.createSessionFromTask launch path.
    LinearService,
    // The Slack documentation bot: per-user Slack tokens (RegistryService), Socket Mode
    // connections dialled OUT from this machine (the api binds 127.0.0.1, so Slack cannot
    // call in), retrieval and the integration row under the operator's JWT
    // (AuthService.cloudClient), and a tool-less one-shot child per answer. Opens and
    // closes its sockets on AuthService's token/clear events.
    SlackService,
    // Documentation RAG indexing: walks the bound checkout's published doc folders
    // (SupervisorService.resolveDocsDir guards), hashes and chunks changed files
    // (@kermanych/core), and hands them to the docs-rag Edge Function under the operator's
    // JWT (AuthService.cloudClient). Triggered after pull and by the manual reindex route.
    DocIndexService,
    // The integrated terminal: project-rooted shells (node-pty) that outlive a socket, and
    // their authenticated `/terminal` socket.io namespace.
    TerminalService,
    TerminalGateway,
    // Native sessions: `omp`/`claude` as their own TUI in a TerminalService pty, observed through
    // per-launch hooks (NativeController) and the harness's session file. SupervisorService
    // routes native rows here and subscribes to its events; it never depends back.
    NativeSessionService,
    // The session browser's tools (docs/specs/2026-10-05-embedded-browser.md) as MCP, one
    // bearer per session; the supervisor and NativeSessionService hand its binding to each
    // launch. The browser itself is the desktop app's (`bootstrap({ browser })`).
    BrowserMcpService,
    // Global by design: the api binds 127.0.0.1 but was previously drivable by
    // anything on the machine, including GET /fs/list (arbitrary local directory
    // enumeration). Opt out per route with @Public(), never per module.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
})
export class AppModule {}
