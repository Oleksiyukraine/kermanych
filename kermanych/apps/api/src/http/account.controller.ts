import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { isAgentLanguage, isSkillImprovementLevel, SKILL_IMPROVEMENT_LEVELS, type AgentLanguage, type SkillImprovementLevel } from "@kermanych/core";
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

  // The skill improvement level (docs/specs/2026-11-06-skill-improvement-reflection.md): the UI
  // writes profiles.skill_improvement_level first, then POSTs here so the improve_skill gate and
  // the reflection step see it. Unknown counts as the cloud column's default.
  @Get("skill-improvement")
  getSkillImprovement(): { level: SkillImprovementLevel } {
    return { level: this.registry.skillImprovementLevel() };
  }

  @Post("skill-improvement")
  setSkillImprovement(@Body() b: { level?: unknown }): { level: SkillImprovementLevel } {
    if (!isSkillImprovementLevel(b?.level))
      throw new BadRequestException(`level must be one of ${SKILL_IMPROVEMENT_LEVELS.join(", ")}, got ${JSON.stringify(b?.level)}`);
    const cur = this.registry.getAuthSession();
    if (!cur) throw new BadRequestException("not signed in");
    this.registry.setAuthSession({ ...cur, skillImprovementLevel: b.level });
    return { level: b.level };
  }
}
