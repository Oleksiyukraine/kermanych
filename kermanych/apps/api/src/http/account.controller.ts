import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common";
import { isAgentRuntime, isAgentLanguage, type AgentRuntimeKind, type AgentLanguage } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { RuntimeCheckService, type RuntimeCheck } from "../runtime/runtime-check.service";

// The signed-in user's per-account runtime preference, cached locally. Source of truth is
// the cloud `profiles.agent_runtime`; the UI writes that under its own JWT, then POSTs here
// so the launch path (SupervisorService.runtimeFor) sees the change without a network read.
@Controller("account")
export class AccountController {
  constructor(
    private registry: RegistryService,
    private checks: RuntimeCheckService,
  ) {}

  @Get("runtime")
  getRuntime(): { runtime: AgentRuntimeKind | null } {
    return { runtime: this.registry.getAuthSession()?.agentRuntime ?? null };
  }

  // Is this backend usable on THIS machine? Asked when the operator picks one, so a signed-out
  // CLI is named at that moment instead of surfacing later as a session that cannot answer.
  // Read-only on purpose: a failed check does not block the choice — the operator may be about
  // to run `claude /login` — it only tells them what to fix first.
  @Get("runtime/check")
  async checkRuntime(@Query("runtime") runtime?: string): Promise<RuntimeCheck> {
    if (!isAgentRuntime(runtime)) throw new BadRequestException(`unknown runtime ${JSON.stringify(runtime)}`);
    return this.checks.check(runtime);
  }

  @Post("runtime")
  setRuntime(@Body() b: { runtime?: string }): { runtime: AgentRuntimeKind } {
    if (!isAgentRuntime(b?.runtime)) throw new BadRequestException(`unknown runtime ${JSON.stringify(b?.runtime)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, agentRuntime: b.runtime });
    return { runtime: b.runtime };
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

  // The skill self-improvement switch (docs/specs/2026-11-04-skill-self-improvement.md): the UI
  // writes profiles.skill_improvement first, then POSTs here so the improve_skill gate sees it.
  // Unknown counts as on, the cloud column's default.
  @Get("skill-improvement")
  getSkillImprovement(): { on: boolean } {
    return { on: this.registry.getAuthSession()?.skillImprovement ?? true };
  }

  @Post("skill-improvement")
  setSkillImprovement(@Body() b: { on?: unknown }): { on: boolean } {
    if (typeof b?.on !== "boolean") throw new BadRequestException(`on must be a boolean, got ${JSON.stringify(b?.on)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, skillImprovement: b.on });
    return { on: b.on };
  }
}
