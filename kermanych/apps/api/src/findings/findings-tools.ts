// apps/api/src/findings/findings-tools.ts
// «Знахідки» (docs/specs/2026-10-13-agent-findings.md): the two tools a session's agent uses to
// hand the operator a problem it noticed outside its own task. They ride on the session's
// existing `kermanych` MCP server (browser/browser-mcp.service.ts) — a child gets one server —
// and, unlike the browser tools, need no desktop app: they only touch this machine's registry.
//
// The descriptions are the agent's whole instruction. Every runtime reads MCP tool descriptions
// (omp, claude, native TUIs), so no system prompt grows and a native session still has nothing
// of Kermanych in its context beyond its tools.
import { FINDING_KINDS, FINDING_TITLE_MAX, OPEN_FINDINGS_LIMIT, validateFindingReport } from "@kermanych/core";
import type { RegistryService } from "../registry/registry.service";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const FINDING_TOOLS = [
  {
    name: "report_finding",
    description:
      "Hand the operator a problem you noticed OUTSIDE your current task, so they can file it as a task on the Kermanych board or in Jira. " +
      "Report a real problem: a bug, a vulnerability, broken or dead code, documentation that contradicts the code, or significant tech debt. " +
      "Something that is part of your current task is not a finding: fix it instead. " +
      "Do not get side-tracked: record the finding and continue your task. Do not fix it on this branch unless the operator asked. " +
      "Report only what you saw in code or output, with `path:line` references or a reproduction command — no guesses, no style advice. " +
      "Call list_findings first and do not report anything already there, including dismissed findings. " +
      `Write every field in English. Nothing is filed until the operator decides; at most ${OPEN_FINDINGS_LIMIT} findings of a session can wait at once.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: FINDING_TITLE_MAX, description: `One line, at most ${FINDING_TITLE_MAX} characters: the problem, recognisable on a kanban card.` },
        kind: { type: "string", enum: [...FINDING_KINDS], description: "bug, security (a vulnerability), tech-debt (broken, dead or fragile code), or docs (documentation that contradicts the code)." },
        context: { type: "string", description: "What is wrong and why it matters." },
        evidence: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Where you saw it: `path:line` references and/or commands that reproduce it.",
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "What must be true once it is fixed, one checkable statement each.",
        },
        suggestedFix: { type: "string", description: "Optional: a short idea of the fix." },
      },
      required: ["title", "kind", "context", "evidence", "acceptanceCriteria"],
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description:
      "The findings this session already reported, in every state: open (waiting for the operator), filed (with the board card or Jira key it became) and dismissed. " +
      "Call it before report_finding so you never report the same problem twice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const FINDING_TOOL_NAMES: ReadonlySet<string> = new Set(FINDING_TOOLS.map((t) => t.name));

/**
 * One findings tool call for `sessionId`. `reported` is told after a finding is stored, so the
 * session's open counter reaches the operator at once. A refusal is a tool error the agent can
 * act on within its turn.
 */
export function callFindingTool(
  registry: RegistryService,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  reported: () => void,
): ToolResult {
  if (name === "list_findings") {
    const rows = registry.listFindings(sessionId);
    if (!rows.length) return { content: [{ type: "text", text: "No findings reported in this session yet." }] };
    const lines = rows.map((f) => {
      const where = f.target?.kind === "jira" ? ` → Jira ${f.target.key}` : f.target?.kind === "board" ? " → board card" : "";
      return `- [${f.status}${where}] (${f.kind}) ${f.title}  id=${f.id}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
  const v = validateFindingReport(args);
  if (!v.ok) return { content: [{ type: "text", text: `Not recorded: ${v.error}.` }], isError: true };
  if (registry.countOpenFindings(sessionId) >= OPEN_FINDINGS_LIMIT)
    return {
      content: [
        {
          type: "text",
          text: `Not recorded: ${OPEN_FINDINGS_LIMIT} findings of this session already wait for the operator. Stop reporting; mention any further problem to the operator in your reply instead.`,
        },
      ],
      isError: true,
    };
  const f = registry.addFinding(sessionId, v.report);
  reported();
  return {
    content: [
      {
        type: "text",
        text: `Recorded finding ${f.id}. The operator sees it in the session's «Знахідки» tab and decides whether it becomes a task. Continue your current task.`,
      },
    ],
  };
}
