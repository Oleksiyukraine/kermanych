// Explicit re-exports, NOT `export *`. TypeScript compiles `export *` to a runtime
// `__exportStar` loop, and esbuild's cjs-module-lexer — which is what Vite uses to give a
// CommonJS dependency named ESM bindings — cannot see through it: the prebundle then carries
// a lone `export default`, and every `import { listProjects } from "@kermanych/cloud"` in the
// ui is `undefined` at runtime. The named form below compiles to
// `Object.defineProperty(exports, "listProjects", { get … })`, which the lexer does detect.
export type {
  TaskStatus,
  Profile,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  AssignableRole,
  CloudProject,
  Task,
  TaskInsert,
  TaskPatch,
  AiScope,
  AiOwner,
  AiSkill,
  AiSkillInsert,
  AiAgentSkill,
  AiAgent,
  AiAgentInsert,
  TriggerSource,
  TriggerAction,
  AiTrigger,
  AiTriggerInsert,
  RiskKind,
  RiskCategory,
  RiskResponse,
  RiskStatus,
  RiskEventKind,
  WorkspaceRisk,
  WorkspaceRiskInsert,
  WorkspaceRiskPatch,
  WorkspaceRiskEvent,
  WorkspaceReleaseNote,
  WorkspaceReleaseNoteInsert,
  WorkspaceReleaseNotePatch,
  JiraStatusCategory,
  JiraIntegration,
  JiraIntegrationInsert,
  JiraSyncState,
  JiraColumn,
  JiraIssue,
  JiraComment,
  JiraWorklog,
  JiraAttachment,
  LinearStatusCategory,
  LinearIntegration,
  LinearIntegrationInsert,
  LinearSyncState,
  LinearColumn,
  LinearIssue,
  LinearComment,
  LinearAttachment,
  WorkspacePassword,
  WorkspacePasswordSecret,
  WorkspacePasswordInsert,
  WorkspacePasswordPatch,
  WorkspacePasswordAccess,
  PasswordAccessStatus,
} from "./types";

export type { SupabaseClient, CloudEnv, CloudClientOptions } from "./client";
export { cloudEnv, createCloudClient } from "./client";

export { TERMINAL_TASK_STATUSES, taskStatusFromSession, isTerminalTaskStatus } from "./status";

export { getMyAgentRuntime, setMyAgentRuntime, getMyAgentLanguage, setMyAgentLanguage } from "./account";

export type { CloudProjectPatch, CloudProjectInsert } from "./projects";
export {
  toCloudProject,
  toProjectRow,
  listProjects,
  createProject,
  patchProject,
  deleteProject,
} from "./projects";

export type {
  DocIndexFile,
  DocIndexState,
  DocSearchStatus,
  DocSearchResult,
  DocIndexUpsert,
  DocIndexDelete,
  DocIndexRequest,
  DocIndexResult,
} from "./doc-rag";
export { getDocIndexState, searchProjectDocs, indexProjectDocs } from "./doc-rag";

export type { CloudWorkspacePatch, CloudWorkspaceInsert } from "./workspaces";
export {
  toWorkspace,
  toWorkspaceRow,
  listWorkspaces,
  createWorkspace,
  patchWorkspace,
  deleteWorkspace,
  listMembers,
  inviteMember,
  removeMember,
  setMemberRole,
} from "./workspaces";

export type { TaskChange, TaskChannelState } from "./tasks";
export {
  toTask,
  toTaskRow,
  listTasks,
  getTask,
  createTask,
  patchTask,
  claimTask,
  pushTaskStatus,
  forceStopTask,
  deleteTask,
  uploadTaskImages,
  signedTaskImageUrls,
  TASK_IMAGE_BUCKET,
  REALTIME_IN_FILTER_MAX,
  tasksFilter,
  subscribeTasks,
} from "./tasks";

export {
  toAiSkill,
  listAiSkills,
  upsertAiSkill,
  deleteAiSkill,
} from "./skills";

export { toAiAgentSkill, listAiAgentSkills, setAiAgentSkills } from "./agent-skills";

export {
  toAiAgent,
  listAiAgents,
  upsertAiAgent,
  deleteAiAgent,
} from "./ai-agents";

export {
  toAiTrigger,
  listAiTriggers,
  upsertAiTrigger,
  setAiTriggerSkills,
  deleteAiTrigger,
} from "./triggers";

export {
  toWorkspaceRisk,
  toWorkspaceRiskEvent,
  toRiskRow,
  listWorkspaceRisks,
  createWorkspaceRisk,
  patchWorkspaceRisk,
  deleteWorkspaceRisk,
  listRiskEvents,
} from "./risks";

export {
  toWorkspaceReleaseNote,
  listWorkspaceReleaseNotes,
  createWorkspaceReleaseNote,
  patchWorkspaceReleaseNote,
} from "./release-notes";

export {
  PASSWORD_FILE_BUCKET,
  toWorkspacePassword,
  toWorkspacePasswordSecret,
  toWorkspacePasswordAccess,
  listWorkspacePasswords,
  getPasswordSecret,
  createWorkspacePassword,
  patchWorkspacePassword,
  patchPasswordSecret,
  setPasswordFile,
  clearPasswordFile,
  signedPasswordFileUrl,
  deleteWorkspacePassword,
  listPasswordAccess,
  requestPasswordAccess,
  decidePasswordAccess,
} from "./passwords";

export type { JiraIssueChange, JiraIssueChildren } from "./jira";
export {
  toJiraIntegration,
  toJiraIssue,
  toJiraIssueRow,
  getJiraIntegration,
  upsertJiraIntegration,
  deleteJiraIntegration,
  getJiraSyncState,
  ensureJiraSyncState,
  takeJiraSyncLease,
  advanceJiraSyncCursor,
  listJiraColumns,
  replaceJiraColumns,
  listJiraIssues,
  upsertJiraIssues,
  deleteJiraIssues,
  patchJiraIssueBinding,
  listJiraIssueChildren,
  listJiraWorklogsBetween,
  replaceJiraIssueChildren,
  subscribeJiraIssues,
} from "./jira";

export type { LinearIssueChange, LinearIssueChildren } from "./linear";
export {
  toLinearIntegration,
  toLinearIssue,
  toLinearIssueRow,
  getLinearIntegration,
  upsertLinearIntegration,
  deleteLinearIntegration,
  getLinearSyncState,
  ensureLinearSyncState,
  takeLinearSyncLease,
  advanceLinearSyncCursor,
  listLinearColumns,
  replaceLinearColumns,
  listLinearIssues,
  upsertLinearIssues,
  deleteLinearIssues,
  patchLinearIssueBinding,
  listLinearIssueChildren,
  replaceLinearIssueChildren,
  subscribeLinearIssues,
} from "./linear";
