// apps/api/src/http/groups.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";
import { EnvFileService } from "../env/env-file.service";

@Controller("groups")
export class GroupsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
    private env: EnvFileService,
  ) {}

  @Get()
  list() {
    return this.reg.listGroups();
  }

  @Post()
  async create(@Body() b: { name: string; projectDir: string; carryFiles?: string[] }) {
    try {
      return await this.sup.addGroup(b.name, b.projectDir, b.carryFiles);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() b: { previewCommand?: string; apiCommand?: string; carryFiles?: string[] },
  ) {
    try {
      return await this.sup.updateGroup(id, b);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get(":id/env")
  async getEnv(@Param("id") id: string, @Query("file") file?: string) {
    const g = this.reg.listGroups().find((x) => x.id === id);
    if (!g) throw new BadRequestException("group not found");
    try {
      return await this.env.read(g.projectDir, file || ".env");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Put(":id/env")
  async putEnv(
    @Param("id") id: string,
    @Body() b: { file?: string; set?: Record<string, string>; remove?: string[] },
  ) {
    const g = this.reg.listGroups().find((x) => x.id === id);
    if (!g) throw new BadRequestException("group not found");
    try {
      return await this.env.write(g.projectDir, b.file || ".env", { set: b.set, remove: b.remove });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.sup.removeGroup(id);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }
}
