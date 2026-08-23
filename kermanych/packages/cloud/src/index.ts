// Explicit re-exports, NOT `export *`. TypeScript compiles `export *` to a runtime
// `__exportStar` loop, and esbuild's cjs-module-lexer — which is what Vite uses to give a
// CommonJS dependency named ESM bindings — cannot see through it: the prebundle then carries
// a lone `export default`, and every `import { listProjects } from "@kermanych/cloud"` in the
// ui is `undefined` at runtime. The named form below compiles to
// `Object.defineProperty(exports, "listProjects", { get … })`, which the lexer does detect.
export type {
  TaskStatus,
  Profile,
  CloudProject,
  ProjectMember,
  Task,
  TaskInsert,
  TaskPatch,
} from "./types";

export type { SupabaseClient, CloudEnv, CloudClientOptions } from "./client";
export { cloudEnv, createCloudClient } from "./client";

export { TERMINAL_TASK_STATUSES, taskStatusFromSession, isTerminalTaskStatus } from "./status";

export type { CloudProjectPatch } from "./projects";
export {
  toCloudProject,
  toProjectRow,
  listProjects,
  createProject,
  patchProject,
  listMembers,
  addMember,
  removeMember,
  deleteProject,
} from "./projects";

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
  REALTIME_IN_FILTER_MAX,
  tasksFilter,
  subscribeTasks,
} from "./tasks";
