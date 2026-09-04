// Cloud coordination rows in camelCase. Postgres columns are snake_case; the
// mapping lives inside this package (see projects.ts / tasks.ts) and nothing
// outside @kermanych/cloud ever sees a snake_case key.
import type { AgentRuntime, RiskCategory, RiskKind, RiskResponse, RiskStatus, SessionStatus, ThinkingLevel } from "@kermanych/core";

// Re-exported from core so the cloud enum and the local session enum cannot drift.
// The Postgres type `task_status` carries the same ten labels.
export type TaskStatus = SessionStatus;

export type Profile = {
  id: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
  agentRuntime?: AgentRuntime;
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
  // The «за замовчуванням» a new task/agent in this project pre-selects: `defaultModel` is an
  // omp model id. Absent = leave the choice to omp, which is what an empty picker already means.
  defaultModel?: string;
  // `defaultEffort` an omp thinking level, the reasoning half of the same launch default.
  defaultEffort?: ThinkingLevel;
  carryFiles: string[];
  envKeys: string[]; // key NAMES only — values never leave the bound repo's .env
  color?: string;
  // The group that owns this project AND supplies its member list. `not null` in
  // Postgres: there are no workspace-less projects in the cloud.
  workspaceId: string;
  createdAt: string;
};

export type WorkspaceRole = "owner" | "manager" | "developer";

// The roles the owner may assign through set_workspace_member_role. 'owner' is
// excluded: it is the creator's seat (workspaces.owner_id) and transfer is out of scope.
export type AssignableRole = Exclude<WorkspaceRole, "owner">;

export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
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
  // omp reasoning effort, stored beside `model` and fed to the launch the same way. Free
  // text in Postgres (omp owns the vocabulary), taken at its word here — see toTask().
  effort?: ThinkingLevel;
  prefix?: string;
  platform?: string;
  // `tasks.worktree` is `not null default true`, so unlike every other launch param this
  // key is always present. `false` means the launcher's «Ізолювати у worktree» was cleared:
  // run in the project folder itself. createSessionFromTask honours that only for the
  // card's author (a shared card must never commandeer another developer's checkout).
  worktree: boolean;
  kind?: string;
  branch?: string;
  // Storage object paths in the `task-images` bucket (private). The board mints signed
  // URLs from these on demand; the row never carries a URL. Absent when the task has none.
  imagePaths?: string[];
  // The Jira ticket key («KAN-42») when this row is a shadow task minted by launching a
  // mirrored ticket. The native board filters these out; the Jira view joins on them.
  jiraKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskInsert = {
  projectId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  model?: string;
  effort?: ThinkingLevel | ""; // "" from the board's shared create/edit form; toTaskRow nulls it
  prefix?: string;
  platform?: string;
  // Supplied ONLY by the one-time publication of pre-cutover local backlog rows, which
  // reuses the local session id so a repeated pass collides instead of duplicating. Same
  // trick as CloudProjectInsert.id (projects.ts:95).
  id?: string;
  worktree?: boolean;
  kind?: string;
  branch?: string;
  imagePaths?: string[];
  jiraKey?: string;
};

export type TaskPatch = {
  title?: string;
  description?: string;
  assigneeId?: string | null; // null clears the assignee
  model?: string;
  effort?: ThinkingLevel | ""; // "" clears the column (toTaskRow turns a blank into null)
  prefix?: string;
  platform?: string;
  worktree?: boolean;
  kind?: string;
  branch?: string;
  imagePaths?: string[];
  jiraKey?: string;
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

// ── Risk register ───────────────────────────────────────────────────────────────
// The four enums are OWNED by @kermanych/core (packages/core/src/risks.ts) and re-exported
// here, because the management assistant validates a `risk.create` against them in core,
// where this package cannot be imported from. They mirror the Postgres types created in
// 20260830140000_workspace_risks.sql one label for one label. The register is scoped to the
// WORKSPACE — the group that carries the membership — and not to a single project, so one
// register covers everything the group is accountable for. The UI's labels and scoring
// policy live in apps/ui/src/lib/risk.ts, because they are copy and risk-method policy, not
// storage.
export type { RiskKind, RiskCategory, RiskResponse, RiskStatus } from "@kermanych/core";

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

// No `platform` column beside these: a release note covers one project, and a project is
// already one shipping shape (core/release-notes.ts says why).

// One generated release note. Everything except `title` and `bodyMd` is fixed at
// generation time — the trigger workspace_release_notes_touch() freezes the provenance
// columns on update — which is why the patch type below carries only those two.
export type WorkspaceReleaseNote = {
  id: string;
  workspaceId: string;
  // Absent when the project row was deleted after the note was generated; `projectName`
  // is the snapshot that keeps the header readable then.
  projectId?: string;
  projectName: string;
  branch: string;
  // Inclusive ISO dates (YYYY-MM-DD): the range is a calendar answer, like `proximity`.
  rangeFrom: string;
  rangeTo: string;
  title: string;
  bodyMd: string;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
};

export type WorkspaceReleaseNoteInsert = {
  workspaceId: string;
  projectId?: string;
  projectName: string;
  branch: string;
  rangeFrom: string;
  rangeTo: string;
  title: string;
  bodyMd: string;
};

export type WorkspaceReleaseNotePatch = {
  title?: string;
  bodyMd?: string;
};

// ── Jira mirror ───────────────────────────────────────────────────────────────
// One Jira board mirrored per workspace (spec 2026-09-02). These are the camelCase
// shapes of the jira_* tables; jira.ts owns the snake_case boundary. Jira is the
// source of truth — every row here is a cache overwritten from Jira, never merged.

// Jira's own three-way status categorisation. The launch flow's «already in
// progress — don't move it» rule reads THIS, never the free-form status name.
export type JiraStatusCategory = "new" | "indeterminate" | "done";

export type JiraIntegration = {
  id: string;
  workspaceId: string;
  siteUrl: string;
  projectKey: string;
  boardId: number;
  boardName: string;
  connectedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type JiraIntegrationInsert = {
  workspaceId: string;
  siteUrl: string;
  projectKey: string;
  boardId: number;
  boardName: string;
};

export type JiraSyncState = {
  integrationId: string;
  workspaceId: string;
  lastSyncedAt?: string;
  // High-water Jira `updated` timestamp; absent forces a full sweep.
  syncCursor?: string;
};

export type JiraColumn = {
  integrationId: string;
  workspaceId: string;
  position: number;
  name: string;
  // One Jira board column maps a SET of statuses — Jira's model, kept verbatim.
  statusIds: string[];
};

export type JiraIssue = {
  integrationId: string;
  workspaceId: string;
  issueId: string;
  key: string;
  summary: string;
  // Jira's renderedFields HTML. Stored as Jira said it; the UI sanitizes on display.
  descriptionHtml: string;
  typeName: string;
  typeIcon: string;
  priorityName: string;
  priorityIcon: string;
  labels: string[];
  // Jira's time tracking, all three in Jira's own duration spelling («2w 3d 4h»); blank =
  // Jira holds none. `originalEstimate` is planned, `timeSpent` is the sum of the issue's
  // worklogs, and `remainingEstimate` is what logging work adjusts.
  originalEstimate: string;
  timeSpent: string;
  remainingEstimate: string;
  // The same three counters in SECONDS, straight from Jira's `timetracking.*Seconds` —
  // the only form Team Capacity can add up. 0 = Jira holds none.
  originalEstimateSeconds: number;
  timeSpentSeconds: number;
  remainingEstimateSeconds: number;
  // Jira's planning dates in Jira's own spelling (YYYY-MM-DD); blank = not set.
  // `dueDate` is the system `duedate`; `startDate` is the site's «Start date» field,
  // which a site may not have at all — then it stays blank and is not editable.
  startDate: string;
  dueDate: string;
  assigneeAccountId?: string;
  assigneeName?: string;
  assigneeAvatar?: string;
  reporterName?: string;
  statusId: string;
  statusName: string;
  statusCategory: JiraStatusCategory;
  parentKey?: string;
  jiraUpdatedAt: string;
  // Launch binding: the Kermanych repo a launch chose (remembered for relaunches)
  // and the shadow tasks row the session pipeline runs on.
  kermanychProjectId?: string;
  taskId?: string;
  updatedAt: string;
};

export type JiraComment = {
  integrationId: string;
  workspaceId: string;
  issueId: string;
  commentId: string;
  authorName: string;
  authorAvatar: string;
  bodyHtml: string;
  jiraCreatedAt: string;
  jiraUpdatedAt: string;
};

export type JiraWorklog = {
  integrationId: string;
  workspaceId: string;
  issueId: string;
  worklogId: string;
  // Jira's accountId for the author. What «may I edit this entry?» is decided from: Jira
  // gates a worklog write on own-versus-all permissions, and a display name cannot answer
  // that. Blank for rows mirrored before it was recorded — read as «not mine».
  authorAccountId: string;
  authorName: string;
  authorAvatar: string;
  timeSpent: string;
  seconds: number;
  startedAt: string;
  commentHtml: string;
};

export type JiraAttachment = {
  integrationId: string;
  workspaceId: string;
  issueId: string;
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  authorName: string;
  jiraCreatedAt: string;
};
