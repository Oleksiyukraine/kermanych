// routines-runner/store.ts — the runner's database access, with the SERVICE ROLE (the cloud
// runner's agreed exception to «caller's JWT only»; 20261017100000_routines_cloud_runner.sql).
// Every query names its workspace or row explicitly: with RLS bypassed, the WHERE clause is the
// isolation, so nothing here lists across workspaces except the tick's own routine list.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CloudProject, CloudRoutine, CloudRun, CloudSecrets, RunClaim, RunResult, Store } from "./runner.ts";

const ROUTINE_COLUMNS = "id, workspace_id, project_id, name, runner, action, schedule, timezone, slack, enabled, armed_at, created_by";
const RUN_COLUMNS =
  "id, routine_id, workspace_id, trigger, scheduled_for, status, started_at, finished_at, run_by, note_id, task_id, commit_count, output_md, slack_channel_name, error_code, error_message, error_params";

type RoutineRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  runner: string;
  action: CloudRoutine["action"];
  schedule: unknown;
  timezone: string;
  slack: CloudRoutine["slack"] | null;
  enabled: boolean;
  armed_at: string;
  created_by: string | null;
};

function toRoutine(r: RoutineRow): CloudRoutine & { runner: string; enabled: boolean } {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    name: r.name,
    runner: r.runner,
    enabled: r.enabled,
    action: r.action,
    schedule: r.schedule,
    timezone: r.timezone,
    ...(r.slack ? { slack: r.slack } : {}),
    armedAt: r.armed_at,
    ...(r.created_by ? { createdBy: r.created_by } : {}),
  };
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

// Absent keeps a column, "" clears it.
function secretColumns(p: CloudSecrets): Record<string, string | null> {
  const map: [keyof CloudSecrets, string][] = [
    ["anthropicApiKey", "anthropic_api_key"],
    ["anthropicModel", "anthropic_model"],
    ["githubToken", "github_token"],
    ["slackBotToken", "slack_bot_token"],
    ["slackTeamId", "slack_team_id"],
    ["slackTeamName", "slack_team_name"],
  ];
  const out: Record<string, string | null> = {};
  for (const [k, col] of map) if (p[k] !== undefined) out[col] = p[k] || null;
  return out;
}

export function serviceStore(db: SupabaseClient): Store {
  return {
    async listCloudRoutines() {
      const rows = check(await db.from("workspace_routines").select(ROUTINE_COLUMNS).eq("runner", "cloud").eq("enabled", true));
      return (rows as RoutineRow[]).map(toRoutine);
    },

    async getRoutine(id) {
      const row = check(await db.from("workspace_routines").select(ROUTINE_COLUMNS).eq("id", id).maybeSingle());
      return row ? toRoutine(row as RoutineRow) : undefined;
    },

    async hasRunningRun(routineId) {
      const rows = check(await db.from("workspace_routine_runs").select("id").eq("routine_id", routineId).eq("status", "running").limit(1));
      return (rows as unknown[]).length > 0;
    },

    async isClaimed(routineId, scheduledFor) {
      const rows = check(
        await db.from("workspace_routine_runs").select("id").eq("routine_id", routineId).eq("scheduled_for", scheduledFor).limit(1),
      );
      return (rows as unknown[]).length > 0;
    },

    async claimRun(c: RunClaim) {
      const status = c.status ?? "running";
      const res = await db
        .from("workspace_routine_runs")
        .insert({
          routine_id: c.routineId,
          trigger: c.trigger,
          scheduled_for: c.scheduledFor ?? null,
          status,
          ...(status === "running" ? {} : { finished_at: new Date().toISOString() }),
          error_code: c.errorCode ?? null,
          error_message: c.errorMessage ?? null,
        })
        .select("id")
        .single();
      if (res.error?.code === "23505") return undefined;
      return (check(res) as { id: string }).id;
    },

    async getRun(id) {
      const row = check(await db.from("workspace_routine_runs").select("id, routine_id, status, scheduled_for, started_at").eq("id", id).maybeSingle()) as {
        id: string;
        routine_id: string;
        status: string;
        scheduled_for: string | null;
        started_at: string;
      } | null;
      if (!row) return undefined;
      const run: CloudRun = { id: row.id, routineId: row.routine_id, status: row.status, startedAt: row.started_at };
      if (row.scheduled_for) run.scheduledFor = row.scheduled_for;
      return run;
    },

    async runRow(id) {
      return check(await db.from("workspace_routine_runs").select(RUN_COLUMNS).eq("id", id).single()) as Record<string, unknown>;
    },

    async finishRun(id, r: RunResult) {
      check(
        await db
          .from("workspace_routine_runs")
          .update({
            status: r.status,
            finished_at: new Date().toISOString(),
            note_id: r.noteId ?? null,
            task_id: r.taskId ?? null,
            commit_count: r.commitCount ?? null,
            output_md: r.outputMd ?? null,
            slack_channel_name: r.slackChannelName ?? null,
            error_code: r.errorCode ?? null,
            error_message: r.errorMessage ?? null,
            error_params: r.errorParams && Object.keys(r.errorParams).length ? r.errorParams : null,
          })
          .eq("id", id),
      );
    },

    // Only cloud routines' runs: a local run is its author's api's to finish, however long.
    async failStaleRuns(startedBefore) {
      const stale = check(
        await db
          .from("workspace_routine_runs")
          .select("id, workspace_routines!inner(runner)")
          .eq("status", "running")
          .eq("workspace_routines.runner", "cloud")
          .lt("started_at", startedBefore),
      ) as { id: string }[];
      if (stale.length === 0) return 0;
      check(
        await db
          .from("workspace_routine_runs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error_code: "routine_cloud_timeout",
            error_message: "the cloud run did not finish in time",
          })
          .in(
            "id",
            stale.map((s) => s.id),
          ),
      );
      return stale.length;
    },

    async disableRoutine(id) {
      check(await db.from("workspace_routines").update({ enabled: false }).eq("id", id));
    },

    async getSecrets(workspaceId) {
      const row = check(
        await db
          .from("workspace_routine_cloud")
          .select("anthropic_api_key, anthropic_model, github_token, slack_bot_token, slack_team_id, slack_team_name")
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
      ) as Record<string, string | null> | null;
      if (!row) return undefined;
      const s: CloudSecrets = {};
      if (row.anthropic_api_key) s.anthropicApiKey = row.anthropic_api_key;
      if (row.anthropic_model) s.anthropicModel = row.anthropic_model;
      if (row.github_token) s.githubToken = row.github_token;
      if (row.slack_bot_token) s.slackBotToken = row.slack_bot_token;
      if (row.slack_team_id) s.slackTeamId = row.slack_team_id;
      if (row.slack_team_name) s.slackTeamName = row.slack_team_name;
      return s;
    },

    async saveSecrets(workspaceId, patch, userId) {
      check(
        await db
          .from("workspace_routine_cloud")
          .upsert({ workspace_id: workspaceId, ...secretColumns(patch), updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "workspace_id" }),
      );
    },

    async listProjects(workspaceId) {
      const rows = check(
        await db.from("projects").select("id, name, git_remote_url, default_branch").eq("workspace_id", workspaceId).order("created_at"),
      ) as { id: string; name: string; git_remote_url: string | null; default_branch: string | null }[];
      return rows.map(
        (p): CloudProject => ({
          id: p.id,
          name: p.name,
          ...(p.git_remote_url ? { gitRemoteUrl: p.git_remote_url } : {}),
          ...(p.default_branch ? { defaultBranch: p.default_branch } : {}),
        }),
      );
    },

    async workspaceName(workspaceId) {
      const row = check(await db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle()) as { name: string } | null;
      return row?.name ?? "";
    },

    // The summary columns as packages/cloud createWorkspaceReleaseNote writes them; `created_by`
    // is kept by the touch trigger only because this insert has no caller.
    async insertReleaseNote(n) {
      const only = n.sources.length === 1 ? n.sources[0] : undefined;
      const row = check(
        await db
          .from("workspace_release_notes")
          .insert({
            workspace_id: n.workspaceId,
            project_id: only?.projectId ?? null,
            project_name: n.sources.map((s) => s.projectName).join(" + "),
            branch: n.sources.map((s) => s.branch).join(" + "),
            sources: n.sources.map((s) => ({ project_id: s.projectId, project_name: s.projectName, branch: s.branch })),
            range_from: n.rangeFrom,
            range_to: n.rangeTo,
            title: n.title,
            body_md: n.bodyMd,
            created_by: n.createdBy ?? null,
          })
          .select("id")
          .single(),
      ) as { id: string };
      return row.id;
    },

    async insertTask(t) {
      const row = check(
        await db
          .from("tasks")
          .insert({
            project_id: t.projectId,
            title: t.title,
            description: t.description,
            assignee_id: t.assigneeId ?? null,
            created_by: t.createdBy ?? null,
            hidden: t.hidden,
          })
          .select("id")
          .single(),
      ) as { id: string };
      return row.id;
    },
  };
}
