// apps/api/src/http/mcp.controller.ts
// «ШІ-команда → MCP-сервери» (docs/specs/2026-11-14-project-mcp-servers.md). Local files only:
// no cloud, and nothing is committed. Behind the global auth guard.
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import type { McpCheckResult, McpProjectView, McpSaveBody, McpWriteResult } from "@kermanych/core";
import { McpError, McpService } from "../mcp/mcp.service";

@Controller("projects/:id/mcp")
export class McpController {
  constructor(private mcp: McpService) {}

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // A write that stopped at a hand-written codex table is an answer, not a failure: the UI shows
  // both tables and asks before sending the write again with `replaceCodex`.
  private async write(fn: () => Promise<McpProjectView>): Promise<McpWriteResult> {
    try {
      return { view: await fn() };
    } catch (err) {
      if (err instanceof McpError && err.conflict) return { conflict: err.conflict };
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get()
  view(@Param("id") id: string): Promise<McpProjectView> {
    return this.read(() => this.mcp.view(id));
  }

  @Post()
  create(@Param("id") id: string, @Body() b: McpSaveBody & { name: string }): Promise<McpWriteResult> {
    return this.write(() => this.mcp.save(id, b?.name ?? "", b, true));
  }

  @Put(":name")
  update(@Param("id") id: string, @Param("name") name: string, @Body() b: McpSaveBody): Promise<McpWriteResult> {
    return this.write(() => this.mcp.save(id, name, b, false));
  }

  @Delete(":name")
  remove(@Param("id") id: string, @Param("name") name: string, @Query("location") loc?: string): Promise<McpProjectView> {
    return this.read(() => this.mcp.remove(id, name, loc === "subdir" ? "subdir" : "root"));
  }

  @Post(":name/copy")
  copy(@Param("id") id: string, @Param("name") name: string, @Body() b: { replaceCodex?: boolean }): Promise<McpWriteResult> {
    return this.write(() => this.mcp.copyToMcpJson(id, name, !!b?.replaceCodex));
  }

  @Post(":name/move-to-root")
  moveToRoot(@Param("id") id: string, @Param("name") name: string, @Body() b: { replaceCodex?: boolean }): Promise<McpWriteResult> {
    return this.write(() => this.mcp.moveToRoot(id, name, !!b?.replaceCodex));
  }

  @Post(":name/check")
  check(@Param("id") id: string, @Param("name") name: string, @Query("location") loc?: string): Promise<McpCheckResult> {
    return this.read(() => this.mcp.check(id, name, loc === "subdir" ? "subdir" : "root"));
  }
}
