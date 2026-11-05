import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { isAgentLanguage, type AgentLanguage } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { RuntimeCheckService, type RuntimeCheck } from "../runtime/runtime-check.service";

// The signed-in user's per-account settings the launch path reads locally, and whether omp is
// usable on this machine.
@Controller("account")
export class AccountController {
  constructor(
    private registry: RegistryService,
    private checks: RuntimeCheckService,
  ) {}

  // Is omp usable on THIS machine? Kermanych's AI functions and «Керманич» sessions all run on
  // it, so a signed-out omp is named up front instead of surfacing later as a session that
  // cannot answer. Read-only: it only tells the operator what to fix (`omp login`).
  @Get("runtime/check")
  checkRuntime(): Promise<RuntimeCheck> {
    return this.checks.check();
  }

  @Get("language")
  getLanguage(): { language: AgentLanguage | null } {
    return { language: this.registry.getAuthSession()?.agentLanguage ?? null };
  }

  @Post("language")
  setLanguage(@Body() b: { language?: string }): { language: AgentLanguage } {
    if (!isAgentLanguage(b?.language)) throw new BadRequestException(`unknown language ${JSON.stringify(b?.language)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, agentLanguage: b.language });
    return { language: b.language };
  }
}
