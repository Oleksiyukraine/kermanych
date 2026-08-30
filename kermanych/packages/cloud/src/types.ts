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
  kind?: string;
  branch?: string;
  // Storage object paths in the `task-images` bucket (private). The board mints signed
  // URLs from these on demand; the row never carries a URL. Absent when the task has none.
  imagePaths?: string[];
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
  imagePaths?: string[];
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
  imagePaths?: string[];
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

// ── Risk register ───────────────────────────────────────────────────────────────
// The four enums mirror the Postgres types created in 20260830140000_workspace_risks.sql
// one label for one label. The register is scoped to the WORKSPACE — the group that carries
// the membership — and not to a single project, so one register covers everything the group
// is accountable for. The UI's labels and scoring policy live in apps/ui/src/lib/risk.ts,
// because they are copy and risk-method policy, not storage.
export type RiskKind = "threat" | "opportunity";

export type RiskCategory =
  | "technical"
  | "security"
  | "vendor"
  | "resource"
  | "external"
  | "compliance"
  | "organizational"
  | "legacy"
  | "key_person"
  | "infrastructure"
  | "data_migration"
  | "performance"
  | "licensing"
  | "ai_model";

// Threat strategies and opportunity strategies share the type; which set is legal for a
// given row is decided by its `kind` and enforced by workspace_risks_response_matches_kind.
export type RiskResponse =
  | "avoid"
  | "reduce"
  | "transfer"
  | "escalate"
  | "exploit"
  | "enhance"
  | "share"
  | "accept";

export type RiskStatus = "open" | "treated" | "closed" | "materialized";

// One row of the register. `code`, `exposure`, `emv`, `residualExposure`, `closedAt` and
// every audit field are SERVER-owned (generated columns and workspace_risks_touch()), which
// is why none of them appear on the insert or patch types.
export type WorkspaceRisk = {
  id: string;
  workspaceId: string;
  code: string;
  kind: RiskKind;
  category: RiskCategory;
  // The statement, in the three parts that make it scoreable.
  cause: string;
  event: string;
  consequence: string;
  probability: number;
  impact: number;
  exposure: number;
  costImpact?: number;
  probabilityPct?: number;
  emv?: number;
  // ISO date (YYYY-MM-DD), not a timestamp: proximity is a calendar answer.
  proximity?: string;
  response: RiskResponse;
  responseActions: string;
  actionOwner?: string;
  actionDue?: string;
  riskOwner?: string;
  residualProbability?: number;
  residualImpact?: number;
  residualExposure?: number;
  earlyWarning: string;
  status: RiskStatus;
  closureNote: string;
  closedAt?: string;
  raisedAt: string;
  raisedBy?: string;
  lastReviewedAt: string;
  updatedAt: string;
  updatedBy?: string;
};

export type WorkspaceRiskInsert = {
  workspaceId: string;
  kind: RiskKind;
  category: RiskCategory;
  cause: string;
  event: string;
  consequence: string;
  probability: number;
  impact: number;
  costImpact?: number;
  probabilityPct?: number;
  proximity?: string;
  response: RiskResponse;
  responseActions?: string;
  actionOwner?: string;
  actionDue?: string;
  riskOwner?: string;
  residualProbability?: number;
  residualImpact?: number;
  earlyWarning?: string;
  status?: RiskStatus;
  closureNote?: string;
};

// `null` clears an optional column; an absent key leaves it alone. `lastReviewedAt` is the
// only audit field a client may write, and only to the current instant — that write IS the
// «reviewed at the cadence» record the event log picks up.
export type WorkspaceRiskPatch = {
  kind?: RiskKind;
  category?: RiskCategory;
  cause?: string;
  event?: string;
  consequence?: string;
  probability?: number;
  impact?: number;
  costImpact?: number | null;
  probabilityPct?: number | null;
  proximity?: string | null;
  response?: RiskResponse;
  responseActions?: string;
  actionOwner?: string | null;
  actionDue?: string | null;
  riskOwner?: string | null;
  residualProbability?: number | null;
  residualImpact?: number | null;
  earlyWarning?: string;
  status?: RiskStatus;
  closureNote?: string;
  lastReviewedAt?: string;
};

export type RiskEventKind = "created" | "scored" | "response" | "status" | "reviewed" | "edited";

// An append-only line of a risk's history. `fromValue`/`toValue` carry machine tokens —
// enum labels for `status`/`response`, `3x4 / 2x2` for `scored` — so the UI phrases them
// with the same label tables it renders the row itself with.
export type WorkspaceRiskEvent = {
  id: number;
  riskId: string;
  at: string;
  actor?: string;
  kind: RiskEventKind;
  fromValue: string;
  toValue: string;
};
