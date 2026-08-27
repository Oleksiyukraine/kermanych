// The RESOLVED view of a project's skill library. Writes go straight from the UI to
// Supabase (RLS is the gate); only this read needs the API, because the repository-shadow
// check is a filesystem question about this machine's checkout.
import { BadRequestException, Controller, Get, Param, ServiceUnavailableException } from "@nestjs/common";
import type { SkillView } from "@kermanych/core";
import { SkillsService } from "../skills/skills.service";
import { RegistryService } from "../registry/registry.service";

@Controller("projects")
export class SkillsController {
  constructor(
    private skills: SkillsService,
    private registry: RegistryService,
  ) {}

  @Get(":id/skills")
  async list(@Param("id") id: string): Promise<SkillView[]> {
    const project = this.registry.listProjects().find((p) => p.id === id);
    if (!project) throw new BadRequestException("project not found");
    try {
      // An unbound project has no checkout to scan; the view then reports no shadowing.
      return await this.skills.view(id, project.localRepoPath);
    } catch (err) {
      // `view` rejects rather than degrade to the defaults, so that a failed cloud read
      // cannot be mistaken for "this project has no skills". 503 carries that distinction
      // to the UI, which shows the message instead of an empty library — and it keeps the
      // rejection out of Nest's unhandled-500 path.
      throw new ServiceUnavailableException(`skill library unavailable: ${(err as Error).message}`);
    }
  }
}
