// Cloud coordination rows in camelCase. Postgres columns are snake_case; the
// mapping lives inside this package (see projects.ts / tasks.ts) and nothing
// outside @kermanych/cloud ever sees a snake_case key.
import type { SessionStatus } from "@kermanych/core";

// Re-exported from core so the cloud enum and the local session enum cannot drift.
// The Postgres type `task_status` carries the same ten labels.
export type TaskStatus = SessionStatus;

export type Profile = {
  id: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type Workspace = {
  id: string;
  name: string;
  color?: string;
  ownerId: string;
  createdAt: string;
};

export type CloudProject = {
  id: string;
  name: string;
  gitRemoteUrl?: string;
  conventions?: string;
  previewCommand?: string;
  apiCommand?: string;
  defaultBranch?: string;
  carryFiles: string[];
  envKeys: string[]; // key NAMES only — values never leave the bound repo's .env
  color?: string;
  // The group that owns this project AND supplies its member list. `not null` in
  // Postgres: there are no workspace-less projects in the cloud.
  workspaceId: string;
  createdAt: string;
};

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: "owner" | "member";
  addedAt: string;
  profile?: Profile; // joined when the caller asks for it
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assigneeId?: string;
  // Nullable: tasks.created_by is `on delete set null`, so a task outlives the
  // account that filed it.
  createdBy?: string;
  // Launch params the assignee's machine feeds into registry.createSession().
  model?: string;
  prefix?: string;
  platform?: string;
  // `tasks.worktree` is `not null default true`, so unlike every other launch param this
  // key is always present. `false` means the launcher's «Ізолювати у worktree» was cleared:
  // run in the project folder itself. createSessionFromTask honours that only for the
  // card's author (a shared card must never commandeer another developer's checkout).
  worktree: boolean;
  kind?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskInsert = {
  projectId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  model?: string;
  prefix?: string;
  platform?: string;
  // Supplied ONLY by the one-time publication of pre-cutover local backlog rows, which
  // reuses the local session id so a repeated pass collides instead of duplicating. Same
  // trick as CloudProjectInsert.id (projects.ts:95).
  id?: string;
  worktree?: boolean;
  kind?: string;
  branch?: string;
};

export type TaskPatch = {
  title?: string;
  description?: string;
  assigneeId?: string | null; // null clears the assignee
  model?: string;
  prefix?: string;
  platform?: string;
  worktree?: boolean;
  kind?: string;
  branch?: string;
};

// A per-project skill (the Kermanych UI's library). `enabled: false` on a row whose name
// matches one of Kermanych's DEFAULT_SKILLS is how a project turns that default off.
export type ProjectSkill = {
  projectId: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
};

export type ProjectSkillInsert = {
  projectId: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
};

/** One skill assigned to one Kermanych agent, for one project. */
export type AgentSkill = {
  projectId: string;
  agentId: string;
  skillName: string;
  position: number;
};

export type AgentSkillInsert = { projectId: string; agentId: string; skillName: string; position?: number };

export type TriggerSource = "operator" | "assistant" | "thinking" | "tool";

/** A rule that fires a skill or an agent without the model choosing to. */
export type ProjectTrigger = {
  projectId: string;
  id: string;
  label: string;
  enabled: boolean;
  source: TriggerSource;
  pattern: string;
  pathGlobs: string[];
  action: "skill" | "agent";
  target: string;
  mode: "remind" | "interrupt";
  repeat: "once" | "after-gap";
};

export type ProjectTriggerInsert = Omit<ProjectTrigger, "pathGlobs" | "enabled"> & {
  pathGlobs?: string[];
  enabled?: boolean;
};
