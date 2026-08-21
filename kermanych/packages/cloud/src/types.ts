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
  ownerId: string;
  createdAt: string;
};

export type ProjectMember = {
  projectId: string;
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
  createdBy: string;
  // Launch params the assignee's machine feeds into registry.createSession().
  model?: string;
  prefix?: string;
  platform?: string;
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
  kind?: string;
  branch?: string;
};
