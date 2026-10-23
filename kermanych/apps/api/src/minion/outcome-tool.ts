// apps/api/src/minion/outcome-tool.ts
// «Посіпака» (docs/specs/2026-10-23-minion-auto-run.md, decision 9): the verdict a minion run
// hands Kermanych at the end of its work. It rides on the session's `kermanych` MCP server
// (browser/browser-mcp.service.ts) beside the findings tools, and is listed only for minion
// sessions. Like the findings tools, the description is the agent's instruction for the call;
// MINION_OUTCOME_CONTRACT in its prompt says the same in prose.
import { MINION_OUTCOME_TOOL, MINION_SUMMARY_MAX, MINION_VERDICTS, validateOutcomeReport, type MinionVerdictReport } from "@kermanych/core";
import type { RegistryService } from "../registry/registry.service";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const OUTCOME_TOOL = {
  name: MINION_OUTCOME_TOOL,
  description:
    "Report how this unattended «Посіпака» run ends. Nobody is watching the session: this call is the only way Kermanych learns the outcome. " +
    "Use `ready` when the card's work is done and checked — every acceptance criterion of the card met and the project's checks (typecheck, tests) run for what you changed. " +
    "Kermanych then completes the documentation if the project requires it and has you open the pull request; do not push or open it yourself. " +
    "Use `needs_decision` when you cannot finish without a human: the card contradicts the code, a product choice that is not yours to make, missing access, credentials or data. " +
    "Do not guess past such a blocker. " +
    "The summary: for `ready`, what you changed and the decisions you took within the card's scope; for `needs_decision`, exactly what blocks you and which decision is needed, plus what is already done. " +
    "Call it once, as the last action of your turn, then end the turn. A turn that ends without it counts as a failed run.",
  inputSchema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: [...MINION_VERDICTS], description: "`ready`: done and checked. `needs_decision`: blocked on a human decision." },
      summary: {
        type: "string",
        maxLength: MINION_SUMMARY_MAX,
        description: "A paragraph or two in English: what changed and the decisions taken, or what blocks you and which decision is needed.",
      },
    },
    required: ["outcome", "summary"],
    additionalProperties: false,
  },
};

/**
 * One `report_outcome` call for `sessionId`. `recorded` is told the verdict once it is accepted,
 * so the supervisor holds it for the turn's end. A refusal is a tool error naming what to fix.
 */
export function callOutcomeTool(
  registry: RegistryService,
  sessionId: string,
  args: Record<string, unknown>,
  recorded: (report: MinionVerdictReport) => void,
): ToolResult {
  const session = registry.listSessions().find((s) => s.id === sessionId);
  if (!session?.minion)
    return { content: [{ type: "text", text: `Not recorded: ${MINION_OUTCOME_TOOL} is only for «Посіпака» runs, and this session is not one.` }], isError: true };
  const v = validateOutcomeReport(args);
  if (!v.ok) return { content: [{ type: "text", text: `Not recorded: ${v.error}.` }], isError: true };
  recorded(v.report);
  return { content: [{ type: "text", text: `Recorded: ${v.report.outcome}. End your turn now.` }] };
}
