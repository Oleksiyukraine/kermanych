// apps/api/src/skills/improve-skill-tool.ts
// The `improve_skill` tool (docs/specs/2026-11-04-skill-self-improvement.md) as the session's
// `kermanych` MCP server hands it out. Like the findings tools, the description is the agent's
// whole instruction, and the operator-facing fields are asked in their communication language.
import {
  SKILL_EDITS_MAX,
  SKILL_IMPROVEMENTS_PER_SESSION,
  SKILL_IMPROVEMENT_REASON_MAX,
  SKILL_IMPROVEMENT_SUMMARY_MAX,
  agentLanguageEnglishName,
  type AgentLanguage,
} from "@kermanych/core";
import type { SkillImprovementService } from "./skill-improvement.service";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const IMPROVE_SKILL_TOOL_NAME = "improve_skill";

/** The tool definition, its operator-facing fields asked for in `language`. */
export function improveSkillTool(language: AgentLanguage | undefined) {
  const lang = language ? agentLanguageEnglishName(language) : "English";
  return {
    name: IMPROVE_SKILL_TOOL_NAME,
    description:
      "Improve a skill of the operator's Kermanych skill library when this session showed it is wrong, outdated or missing something. " +
      "The change is applied at once to the operator's personal copy of the skill (their own sessions use it from the next launch; teammates are not affected); " +
      "the operator is notified and can roll it back. " +
      "Call it when: the operator corrected how you did a kind of task this skill describes; the skill turned out wrong, outdated or missing a step; " +
      "or, after failed attempts, you found a working method that is not obvious. " +
      "Do not call it for: a one-off task; an environment or setup failure the operator can fix; an attempt that never worked; claims that some tool does not work; " +
      "facts about this one repository (commands, paths, conventions) — hand those to report_finding as a proposal for the repository's AGENTS.md or docs; " +
      "secrets, tokens or personal data. Most sessions improve nothing, and that is the normal outcome. " +
      "Only existing skills of the Kermanych library that you saw in this session can be improved; " +
      "skills that live in the repository (.claude/skills, .omp/skills and similar) or in home folders are refused. " +
      "Each edit replaces one exact fragment of the skill's current text: copy `find` verbatim from the skill as you read it; it must occur exactly once. " +
      "Write the replacement in the skill's own language, as a general rule with a short why, not as a story of this session. " +
      `Write \`summary\` (one line, at most ${SKILL_IMPROVEMENT_SUMMARY_MAX} characters) and \`reason\` in ${lang}. ` +
      `At most ${SKILL_IMPROVEMENTS_PER_SESSION} improvements per session. After the call, continue your task.`,
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The skill's name as the library lists it, e.g. qa-tester." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: SKILL_EDITS_MAX,
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "An exact fragment of the skill's current text; it must occur exactly once." },
              replace: { type: "string", description: "The text that replaces it; empty removes it." },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
        summary: {
          type: "string",
          maxLength: SKILL_IMPROVEMENT_SUMMARY_MAX,
          description: `What changed, one line, in ${lang}; the operator reads it as «I improved skill X: <summary>».`,
        },
        reason: {
          type: "string",
          maxLength: SKILL_IMPROVEMENT_REASON_MAX,
          description: `What in this session showed the skill needed this change, in ${lang}.`,
        },
      },
      required: ["skill", "edits", "summary", "reason"],
      additionalProperties: false,
    },
  };
}

export async function callImproveSkillTool(service: SkillImprovementService, sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await service.improve(sessionId, args);
  return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
}
