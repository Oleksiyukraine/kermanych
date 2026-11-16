// apps/api/src/supervisor/chat-tools.ts
// Reviews run with a read-only tool subset: they inspect the agent's worktree without ever
// mutating it. A research session («Дослідження», `kind: "chat"`) reads the same way and may
// also search the web (docs/specs/2026-11-16-research-mode.md, decision 2). Promotion to an
// agent later grants the full toolset. Named the omp way (lowercase).
import { researchAppend, type Project, type ResearchProject, type Session } from "@kermanych/core";
import type { RuntimeLaunchOpts } from "../runtime/agent-runtime";

export const CHAT_TOOLS = ["read", "grep", "glob"];
export const RESEARCH_TOOLS = [...CHAT_TOOLS, "web_search"];

// A «Синергія» child edits the app and nothing else (docs/specs/2026-11-06-synergy.md, decision
// 7): no bash (tests, type checks, commits are what made a change take minutes), no subagents.
// The MCP browser tools and `preview_status` / `preview_logs` ride the bridge extension, which
// `--tools` does not filter.
export const SYNERGY_TOOLS = ["read", "edit", "write", "grep", "glob"];

// The tool restriction a managed session runs with — on its first spawn AND on every wake, so a
// woken child keeps the toolset it was created with. Decided by the session, not only its kind:
// a «Синергія» agent is `kind: "agent"` with the narrow set and no LSP (diagnostics and
// formatting after every edit cost seconds per change), until «Імплементувати» clears the
// marker and the next spawn gets the full set. Research reads and searches the web, reviews
// read; a discussion branch only talks (it sits in the parent's directory and must never touch
// it); agents get the backend's full set.
export function launchToolsFor(s: Pick<Session, "kind" | "synergy">): Pick<RuntimeLaunchOpts, "tools" | "noTools" | "noLsp"> {
  if (s.kind === "chat") return { tools: RESEARCH_TOOLS };
  if (s.kind === "review") return { tools: CHAT_TOOLS };
  if (s.kind === "discussion") return { noTools: true };
  if (s.synergy) return { tools: SYNERGY_TOOLS, noLsp: true };
  return {};
}

// What the model is told about that restriction. A discussion branch inherits the parent's
// transcript — full of tool calls — and omp's/claude's system prompt still describes tools, so
// without this the model keeps "starting" a search or a command it cannot make: the turn ends
// on thinking or on "запускаю…" and the branch looks frozen. Reviews see their real toolset in
// the schema, so they need no paragraph. A research session gets its role, its rules and the
// workspace's projects it may read (`research`: its own project and the other bound ones).
export const DISCUSSION_NO_TOOLS_APPEND =
  "This conversation is a discussion branch, forked from another agent's conversation so the operator can talk it through without touching that agent. " +
  "This branch has no tools at all: no file reading, no shell, no web search, no subagents, whatever tools the earlier conversation used. " +
  "A tool call you try to make will not run and the turn ends with nothing done. " +
  "Answer from what the conversation already holds and from your own knowledge. " +
  "When the operator asks for something only a tool can do — reading code, running a command, searching the internet — say plainly that this branch cannot do it and that the parent agent can, and give your best answer without it. " +
  "Never announce that you are about to run, check or look something up.";

export function launchAppendFor(
  kind: Session["kind"],
  research?: { own: ResearchProject; others: ResearchProject[] },
): string | undefined {
  if (kind === "discussion") return DISCUSSION_NO_TOOLS_APPEND;
  if (kind === "chat" && research) return researchAppend(research.own, research.others);
  return undefined;
}

// What a research session may read (docs/specs/2026-11-16-research-mode.md, decision 5): its own
// project, plus every other project of the same workspace bound on this machine. A project with
// no workspace gets itself only.
export function researchProjects(own: Project, all: readonly Project[]): { own: ResearchProject; others: ResearchProject[] } {
  const others = own.workspaceId
    ? all.filter((p) => p.id !== own.id && p.workspaceId === own.workspaceId && p.localRepoPath)
    : [];
  return {
    own: { name: own.name, localRepoPath: own.localRepoPath },
    others: others.map((p) => ({ name: p.name, localRepoPath: p.localRepoPath })),
  };
}
