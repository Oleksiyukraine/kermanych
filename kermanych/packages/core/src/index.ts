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
  NOTICE_CODES,
  API_ERROR_CODES,
  MANAGEMENT_REJECTION_CODES,
  type NoticeCode,
  type ApiErrorCode,
  type ManagementRejectionCode,
  type Locale,
  type NoticeParams,
  type Notice,
  type ApiErrorParams,
  type ApiErrorBody,
  type ManagementRejection,
} from "./i18n-codes";
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
export { TERMINAL_SCROLLBACK } from "./terminal";
export {
  isReleaseDate,
  type ReleaseCommit,
  type ReleaseNotesAsk,
  type ReleaseNotesReply,
} from "./release-notes";
export { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "./thinking";
export { AGENT_RUNTIMES, isAgentRuntime, type AgentRuntimeKind } from "./runtime";
export {
  AGENT_LANGUAGES,
  AGENT_LANGUAGE_LABELS,
  isAgentLanguage,
  agentLanguageDirective,
  type AgentLanguage,
} from "./language";
export { STE_LEVELS, STE_RULES, type SteCell, type SteLevel, type SteRule, type SteRuleId } from "./ste";
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
export { isDocPath, isDocImagePath, isMarkupPath, docsRead } from "./docs";
export {
  DOCS_LAYOUT,
  DOCS_RULES,
  DOCS_POLICY_KEYS,
  DEFAULT_DOCS_POLICY,
  DOCS_GATE_FAILURES,
  TASK_SPEC_SKILL,
  TASK_PLAN_SKILL,
  FRONTEND_HANDOFF_SKILL,
  API_REQUEST_SKILL,
  docsPolicy,
  docsPolicyAppend,
  docsLayoutKind,
  docsGateFailures,
  docsFailureSkills,
  docsCompletionPrompt,
  docsWritePrompt,
  DOCS_WRITE_FAILURE,
  type DocsRule,
  type DocsPolicy,
  type DocsPolicyKey,
  type DocsWriteKind,
  type DocsLayoutKind,
  type DocsGateFailure,
  type DocsGateInput,
  type DocsGate,
} from "./doc-policy";
export { chunkMarkdown, type DocChunk } from "./doc-chunk";
export {
  DEFAULT_HELPERS,
  expandHelpers,
  helperNotice,
  prependHelper,
  type HelperDef,
  type HelperKind,
} from "./helpers";
export {
  DEFAULT_COMMANDS,
  parseCommand,
  prependCommand,
  type CommandDef,
  type ParsedCommand,
} from "./commands";
export {
  AGENTS,
  PR_CONVENTIONS_FALLBACK,
  KERMANYCH_COAUTHOR,
  COAUTHOR_DIRECTIVE,
  DOC_MAINTAIN_DIRECTIVE,
  agentById,
  effectiveInstruction,
  instructionErrors,
  instructionHoles,
  renderInstruction,
  type AgentDef,
  type AgentKind,
} from "./agents";
export { DEEP_ANALYSIS_SKILL, deepAnalysisPrompt } from "./deep-analysis";
export {
  buildChatBlocks,
  THINK_MIN_MS,
  COALESCE_TOOLS,
  type ToolEntry,
  type UserEntry,
  type ChatItem,
  type BlockSummary,
  type ChatBlock,
  type GroupStat,
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
  RISK_EXPORT_FORMATS,
  parseManagementReply,
  renderTicketDescription,
  validateManagementAction,
  validateNewTicket,
  type ManagementAction,
  type ManagementActionKind,
  type ManagementUnsupported,
  type ManagementRiskCreate,
  type ManagementRiskUpdate,
  type ManagementRiskExport,
  type RiskExportFormat,
  type ManagementReleaseNotes,
  type ManagementTicketCreate,
  type ManagementTicketQuestions,
  type ManagementTodoCreate,
  type ManagementRiskFields,
  type ManagementRiskPatch,
  type ManagementRiskRow,
  type ManagementTicketFields,
  type ManagementMember,
  type ManagementDocFragment,
  type ManagementDocs,
  type ManagementJiraBoard,
  type ManagementCapacity,
  type ManagementCapacityPerson,
  type ManagementCapacityWeek,
  type ManagementHome,
  type ManagementHomeTile,
  type ManagementHomeTodoItem,
  type ManagementHomeTask,
  type ManagementHomeTaskGroup,
  type ManagementHomeRelease,
  type ManagementRepo,
  type ManagementWorkspaceProject,
  type ManagementContext,
  type ManagementAttachment,
  type ManagementChatAsk,
  type ManagementChatReply,
  type ParsedManagementReply,
} from "./management-actions";
export {
  QA_CHECKLIST_KIND,
  QA_CHECKLIST_DIRECTIVE,
  parseTaskActions,
  buildQaChecklist,
  type QaChecklist,
  type QaChecklistItem,
  type TaskAction,
} from "./task-actions";
