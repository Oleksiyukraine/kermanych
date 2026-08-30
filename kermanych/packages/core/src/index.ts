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
  DEFAULT_SKILLS,
  SKILL_NAME_RE,
  isSkillName,
  renderSkillFile,
  skillsUsed,
  type SkillDef,
  type SkillView,
} from "./skills";
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
export {
  MANAGEMENT_SECTIONS,
  MANAGEMENT_DEFAULT_SECTION,
  managementSection,
  type ManagementCapability,
  type ManagementSection,
} from "./management";
export {
  RISK_KIND_VALUES,
  RISK_CATEGORY_VALUES,
  RISK_RESPONSE_VALUES,
  RISK_STATUS_VALUES,
  RISK_RESPONSES_BY_KIND,
  RISK_SCORE_MIN,
  RISK_SCORE_MAX,
  isRiskKind,
  isRiskCategory,
  isRiskResponse,
  isRiskStatus,
  isTerminalRiskStatus,
  type RiskKind,
  type RiskCategory,
  type RiskResponse,
  type RiskStatus,
} from "./risks";
export {
  MANAGEMENT_ACTION_FENCE,
  parseManagementReply,
  validateManagementAction,
  type ManagementAction,
  type ManagementActionKind,
  type ManagementUnsupported,
  type ManagementRiskCreate,
  type ManagementRiskUpdate,
  type ManagementRiskFields,
  type ManagementRiskPatch,
  type ManagementRiskRow,
  type ManagementRepo,
  type ManagementWorkspaceProject,
  type ManagementContext,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ParsedManagementReply,
} from "./management-actions";
