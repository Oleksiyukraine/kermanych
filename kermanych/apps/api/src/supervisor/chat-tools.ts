// apps/api/src/supervisor/chat-tools.ts
// Chat sessions run with a read-only tool subset: they explore and plan in the project dir
// without ever mutating it (git-free). Promotion to an agent later grants the full toolset.
// Named the omp way (lowercase). Shared by the managed chat runtime (supervisor.service.ts) and
// a native chat's `--tools` flag (native/native-session.service.ts).
export const CHAT_TOOLS = ["read", "grep", "glob"];
