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
  ProjectSkill,
  ProjectSkillInsert,
  AgentSkill,
  AgentSkillInsert,
  TriggerSource,
  ProjectTrigger,
  ProjectTriggerInsert,
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
} from "./types";

export type { SupabaseClient, CloudEnv, CloudClientOptions } from "./client";
export { cloudEnv, createCloudClient } from "./client";

export { TERMINAL_TASK_STATUSES, taskStatusFromSession, isTerminalTaskStatus } from "./status";

export { getMyAgentRuntime, setMyAgentRuntime } from "./account";

export type { CloudProjectPatch, CloudProjectInsert } from "./projects";
export {
  toCloudProject,
  toProjectRow,
  listProjects,
  createProject,
  patchProject,
  deleteProject,
} from "./projects";

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
  toProjectSkill,
  listProjectSkills,
  upsertProjectSkill,
  deleteProjectSkill,
} from "./skills";

export {
  toAgentSkill,
  listAgentSkills,
  setAgentSkill,
  deleteAgentSkill,
} from "./agent-skills";

export { toTrigger, listTriggers, upsertTrigger, deleteTrigger } from "./triggers";

export {
  toWorkspaceRisk,
  toWorkspaceRiskEvent,
  toRiskRow,
  listWorkspaceRisks,
  createWorkspaceRisk,
  patchWorkspaceRisk,
  listRiskEvents,
} from "./risks";

export {
  toWorkspaceReleaseNote,
  listWorkspaceReleaseNotes,
  createWorkspaceReleaseNote,
  patchWorkspaceReleaseNote,
} from "./release-notes";

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
  replaceJiraIssueChildren,
  subscribeJiraIssues,
} from "./jira";
