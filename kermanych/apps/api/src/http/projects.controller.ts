// apps/api/src/http/projects.controller.ts
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type { CloudProject } from "@kermanych/cloud";
import type { ThinkingLevel } from "@kermanych/core";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";
import { EnvFileService } from "../env/env-file.service";

// LOCAL project rows only: the cloud `projects` table is written by the UI under the
// user's JWT (RLS), and these routes cache it, bind it to a local repo, and serve the
// local-only concerns (branches, .env). There is deliberately no create/delete here.
@Controller("projects")
export class ProjectsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private env: EnvFileService,
  ) {}

  @Get()
  list() {
    return this.reg.listProjects();
  }

  // Literal segment declared before the `:id` routes (route order matters, cf.
  // @Post("chat") above @Post(":id/start") in sessions.controller.ts).
  @Post("sync")
  async sync(@Body() b: { projects: CloudProject[]; prune?: boolean }) {
    try {
      return await this.sup.syncProjects(b.projects ?? [], b.prune ?? false);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() b: { name?: string; color?: string; previewCommand?: string; apiCommand?: string; carryFiles?: string[]; defaultBranch?: string; defaultModel?: string; defaultEffort?: ThinkingLevel | ""; conventions?: string },
  ) {
    try {
      return await this.sup.updateProject(id, b);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/binding")
  async bind(@Param("id") id: string, @Body() b: { localRepoPath: string }) {
    try {
      return await this.sup.bindProject(id, b.localRepoPath ?? "");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/branches")
  async branches(@Param("id") id: string) {
    try {
      return await this.sup.projectBranches(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post(":id/pull")
  async pull(@Param("id") id: string) {
    try {
      return await this.sup.projectPull(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/env")
  async getEnv(@Param("id") id: string, @Query("file") file?: string) {
    const p = this.reg.listProjects().find((x) => x.id === id);
    if (!p) throw new BadRequestException("project not found");
    if (!p.localRepoPath) throw new BadRequestException("project not bound");
    try {
      return await this.env.read(p.localRepoPath, file || ".env");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/env")
  async putEnv(
    @Param("id") id: string,
    @Body() b: { file?: string; set?: Record<string, string>; remove?: string[] },
  ) {
    const p = this.reg.listProjects().find((x) => x.id === id);
    if (!p) throw new BadRequestException("project not found");
    if (!p.localRepoPath) throw new BadRequestException("project not bound");
    try {
      return await this.env.write(p.localRepoPath, b.file || ".env", { set: b.set, remove: b.remove });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }
}
