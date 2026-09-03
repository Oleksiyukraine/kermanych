import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { isAgentRuntime, type AgentRuntimeKind } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";

// The signed-in user's per-account runtime preference, cached locally. Source of truth is
// the cloud `profiles.agent_runtime`; the UI writes that under its own JWT, then POSTs here
// so the launch path (SupervisorService.runtimeFor) sees the change without a network read.
@Controller("account")
export class AccountController {
  constructor(private registry: RegistryService) {}

  @Get("runtime")
  getRuntime(): { runtime: AgentRuntimeKind | null } {
    return { runtime: this.registry.getAuthSession()?.agentRuntime ?? null };
  }

  @Post("runtime")
  setRuntime(@Body() b: { runtime?: string }): { runtime: AgentRuntimeKind } {
    if (!isAgentRuntime(b?.runtime)) throw new BadRequestException(`unknown runtime ${JSON.stringify(b?.runtime)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, agentRuntime: b.runtime });
    return { runtime: b.runtime };
  }
}
