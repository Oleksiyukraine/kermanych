// The RESOLVED view of a project's skill library, plus the names the bound checkout's own
// skill directories define. Writes go straight from the UI to Supabase (RLS is the gate);
// only this read needs the API, because both the repository-shadow check and the
// repository's own name list are filesystem questions about this machine's checkout.
import { BadRequestException, Controller, Get, Param, ServiceUnavailableException } from "@nestjs/common";
import type { ProjectSkillsPayload } from "@kermanych/core";
import { SkillsService, type AiScopeSet } from "../skills/skills.service";
import { RegistryService } from "../registry/registry.service";
import { AuthService } from "../auth/auth.service";

@Controller("projects")
export class SkillsController {
  constructor(
    private skills: SkillsService,
    private registry: RegistryService,
    private auth: AuthService,
  ) {}

  @Get(":id/skills")
  async list(@Param("id") id: string): Promise<ProjectSkillsPayload> {
    const project = this.registry.listProjects().find((p) => p.id === id);
    if (!project) throw new BadRequestException("project not found");
    // The session's effective library merges the project with its workspace and the signed-in
    // operator; the checkout to scan for repository shadowing is always the project's.
    const scope: AiScopeSet = { projectId: id };
    if (project.workspaceId) scope.workspaceId = project.workspaceId;
    const userId = this.auth.current()?.userId;
    if (userId) scope.userId = userId;
    try {
      // An unbound project has no checkout to scan; the view then reports no shadowing.
      return await this.skills.view(scope, project.localRepoPath);
    } catch (err) {
      // `view` rejects rather than degrade to the defaults, so that a failed cloud read
      // cannot be mistaken for "this project has no skills". 503 carries that distinction
      // to the UI, which shows the message instead of an empty library — and it keeps the
      // rejection out of Nest's unhandled-500 path.
      throw new ServiceUnavailableException(`skill library unavailable: ${(err as Error).message}`);
    }
  }
}
