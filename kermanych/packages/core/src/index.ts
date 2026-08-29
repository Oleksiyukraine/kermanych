// Public barrel for @kermanych/core.
//
// Value re-exports are ENUMERATED, never `export *`. tsc compiles an explicit
// `export { name } from "./m"` to a per-name `Object.defineProperty(exports, ...)`,
// which cjs-module-lexer — the detector esbuild/Vite's dep optimizer (and Node) use to
// discover a CJS module's named exports — reliably sees. `export *` instead compiles to
// `__exportStar`, whose names that optimizer does NOT surface: the bundled UI then got
// `undefined` for a barrel value import (e.g. buildChatBlocks) and threw at first use.
// types.ts is type-only (erased at build), so `export *` is safe there.
export * from "./types";
export {
  toolDisplay,
  clampLines,
  shortPath,
  humanBytes,
  PREVIEW_LINES,
  PREVIEW_DEFAULT,
  type ToolDisplay,
} from "./tool-display";
export { LineSplitter, ChunkReassembler } from "./rpc-frames";
export {
  reduceStatus,
  shouldNotify,
  INITIAL_STATUS,
  INTERACTIVE_UI_METHODS,
  ACTIVE_STATUSES,
  NOTIFY_STATUSES,
  type StatusState,
} from "./status";
export {
  slugify,
  taskNameFromText,
  branchName,
  uniqueSlug,
  worktreeDir,
  BRANCH_PREFIXES,
  type BranchPrefix,
} from "./worktree-names";
export { PLATFORMS, type Platform } from "./platform";
export {
  ASSIGNED_BLOCK_HEADER,
  DEFAULT_SKILLS,
  SKILL_NAME_RE,
  assignedBlock,
  isSkillName,
  renderSkillFile,
  skillsUsed,
  type ProjectSkillsPayload,
  type SkillDef,
  type SkillView,
} from "./skills";
export {
  AGENTS,
  PR_CONVENTIONS_FALLBACK,
  agentById,
  renderInstruction,
  type AgentDef,
  type AgentKind,
} from "./agents";
export {
  buildChatBlocks,
  THINK_MIN_MS,
  COALESCE_TOOLS,
  type ToolEntry,
  type UserEntry,
  type ChatItem,
  type BlockSummary,
  type ChatBlock,
} from "./chat-blocks";
