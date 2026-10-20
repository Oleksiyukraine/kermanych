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
