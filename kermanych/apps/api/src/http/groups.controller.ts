// apps/api/src/http/groups.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { SupervisorService } from "../supervisor/supervisor.service";
import { RegistryService } from "../registry/registry.service";

@Controller("groups")
export class GroupsController {
  constructor(
    private sup: SupervisorService,
    private reg: RegistryService,
  ) {}

  @Get()
  list() {
    return this.reg.listGroups();
  }

  @Post()
  async create(@Body() b: { name: string; projectDir: string }) {
    try {
      return await this.sup.addGroup(b.name, b.projectDir);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() b: { previewCommand?: string; apiCommand?: string }) {
    try {
      return await this.sup.updateGroup(id, b);
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
