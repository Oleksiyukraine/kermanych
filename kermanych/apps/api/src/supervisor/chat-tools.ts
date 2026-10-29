// apps/api/src/supervisor/chat-tools.ts
// Chat sessions run with a read-only tool subset: they explore and plan in the project dir
// without ever mutating it (git-free). Promotion to an agent later grants the full toolset.
// Named the omp way (lowercase). Shared by the managed chat runtime (supervisor.service.ts) and
// a native chat's `--tools` flag (native/native-session.service.ts).
import type { Session } from "@kermanych/core";
import type { RuntimeLaunchOpts } from "../runtime/agent-runtime";

export const CHAT_TOOLS = ["read", "grep", "glob"];

// The tool restriction a managed session kind runs with — on its first spawn AND on every
// wake, so a woken child keeps the toolset it was created with. Chats and reviews read; a
// discussion branch only talks (it sits in the parent's directory and must never touch it);
// agents get the backend's full set.
export function launchToolsFor(kind: Session["kind"]): Pick<RuntimeLaunchOpts, "tools" | "noTools"> {
  if (kind === "chat" || kind === "review") return { tools: CHAT_TOOLS };
  if (kind === "discussion") return { noTools: true };
  return {};
}

// What the model is told about that restriction. A discussion branch inherits the parent's
// transcript — full of tool calls — and omp's/claude's system prompt still describes tools, so
// without this the model keeps "starting" a search or a command it cannot make: the turn ends
// on thinking or on "запускаю…" and the branch looks frozen. Chats and reviews see their real
// toolset in the schema, so they need no paragraph.
export const DISCUSSION_NO_TOOLS_APPEND =
  "This conversation is a discussion branch, forked from another agent's conversation so the operator can talk it through without touching that agent. " +
  "This branch has no tools at all: no file reading, no shell, no web search, no subagents, whatever tools the earlier conversation used. " +
  "A tool call you try to make will not run and the turn ends with nothing done. " +
  "Answer from what the conversation already holds and from your own knowledge. " +
  "When the operator asks for something only a tool can do — reading code, running a command, searching the internet — say plainly that this branch cannot do it and that the parent agent can, and give your best answer without it. " +
  "Never announce that you are about to run, check or look something up.";

export function launchAppendFor(kind: Session["kind"]): string | undefined {
  return kind === "discussion" ? DISCUSSION_NO_TOOLS_APPEND : undefined;
}
