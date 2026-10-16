// routines-runner/runner.ts — what the cloud runner does, free of Deno and of supabase-js so it
// is testable from the monorepo's vitest (apps/api/test/routines-cloud-runner.spec.ts). index.ts
// wires it to the platform: the service-role Store, the caller's identity, and the dispatch of
// one run per Edge Function invocation.
//
// The rules are the local runner's (apps/api/src/routines/routines.service.ts) — same schedule
// math, same due rule, same exactly-once claim, same prompts — with three differences the
// operator agreed to for running without anybody online:
//   * the code comes from GitHub with the workspace's read-only token;
//   * the model is Anthropic's API with the workspace's key, billed per use;
//   * Slack posts come from the workspace's bot, and a project prompt only files its card.
import { dueOccurrence, parseRoutineSchedule, releaseRangeFor, routineLocalDate, zonedInstant } from "../_shared/routine-schedule.ts";
import { buildReleaseNotesPrompt, titleOf } from "../_shared/release-notes-prompt.ts";
import { buildRoutineReportPrompt } from "../_shared/routine-report-prompt.ts";
import type { ReleaseGrouping } from "../_shared/release-notes-types.ts";
import { defaultModel, listModels, runModel } from "./anthropic.ts";
import { GitHub, githubTools, parseGitHubRemote, type GitHubRepo } from "./github.ts";
import { botChannels, botIdentity, postDocument } from "./slack.ts";
import { RunFailure } from "./failure.ts";

// A run still `running` after this died with its invocation (the platform's wall-clock limit);
// the next tick records it as failed so the routine can run again.
export const STALE_RUN_MS = 15 * 60 * 1000;

// ── the data the runner reads ─────────────────────────────────────────────────

export type CloudAction =
  | { kind: "prompt"; prompt: string; hideFromBoard?: boolean }
  | { kind: "release_notes"; sources: { projectId: string; branch: string }[]; periodDays: number; groupBy?: ReleaseGrouping };

export type CloudRoutine = {
  id: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  createdBy?: string;
  action: CloudAction;
  schedule: unknown;
  timezone: string;
  slack?: { teamId: string; channelId: string; channelName: string };
  armedAt: string;
};

export type CloudRun = { id: string; routineId: string; status: string; scheduledFor?: string; startedAt: string };

export type CloudSecrets = {
  anthropicApiKey?: string;
  anthropicModel?: string;
  githubToken?: string;
  slackBotToken?: string;
  slackTeamId?: string;
  slackTeamName?: string;
};

export type CloudProject = { id: string; name: string; gitRemoteUrl?: string; defaultBranch?: string };

export type RunClaim = {
  routineId: string;
  trigger: "schedule" | "catch_up" | "manual";
  scheduledFor?: string;
  status?: "running" | "skipped";
  errorCode?: string;
  errorMessage?: string;
};

export type RunResult = {
  status: "succeeded" | "failed" | "skipped";
  noteId?: string;
  taskId?: string;
  commitCount?: number;
  outputMd?: string;
  slackChannelName?: string;
  errorCode?: string;
  errorMessage?: string;
  errorParams?: Record<string, string | number>;
};

// Everything index.ts implements over the service role.
export interface Store {
  listCloudRoutines(): Promise<CloudRoutine[]>;
  getRoutine(id: string): Promise<(CloudRoutine & { runner: string; enabled: boolean }) | undefined>;
  hasRunningRun(routineId: string): Promise<boolean>;
  // Whether an occurrence already has its run (or its skip) — asked first, so a tick does not
  // re-insert into the unique index every minute until the next occurrence.
  isClaimed(routineId: string, scheduledFor: string): Promise<boolean>;
  // The new run's id, or undefined when the occurrence is already claimed (unique violation).
  claimRun(claim: RunClaim): Promise<string | undefined>;
  getRun(id: string): Promise<CloudRun | undefined>;
  runRow(id: string): Promise<Record<string, unknown>>;
  finishRun(id: string, result: RunResult): Promise<void>;
  failStaleRuns(startedBefore: string): Promise<number>;
  disableRoutine(id: string): Promise<void>;
  getSecrets(workspaceId: string): Promise<CloudSecrets | undefined>;
  saveSecrets(workspaceId: string, patch: CloudSecrets, userId: string): Promise<void>;
  listProjects(workspaceId: string): Promise<CloudProject[]>;
  workspaceName(workspaceId: string): Promise<string>;
  insertReleaseNote(note: {
    workspaceId: string;
    sources: { projectId: string; projectName: string; branch: string }[];
    rangeFrom: string;
    rangeTo: string;
    title: string;
    bodyMd: string;
    createdBy?: string;
  }): Promise<string>;
  insertTask(task: { projectId: string; title: string; description: string; assigneeId?: string; createdBy?: string; hidden: boolean }): Promise<string>;
}

// Who called a member action, as the caller's own JWT proves it.
export interface Caller {
  userId: string;
  isMember(workspaceId: string): Promise<boolean>;
  isOwner(workspaceId: string): Promise<boolean>;
}

export type Deps = {
  store: Store;
  fetch: typeof fetch;
  now: () => number;
  // Starts one run in its own invocation; the run's work does not share the tick's budget.
  dispatch: (runId: string) => Promise<void>;
  // The wall-clock a run may spend (the platform's limit, less a margin).
  runBudgetMs: number;
};

// ── tick: claim what is due ───────────────────────────────────────────────────

export async function tick(d: Deps): Promise<{ claimed: number; stale: number }> {
  const now = d.now();
  const stale = await d.store.failStaleRuns(new Date(now - STALE_RUN_MS).toISOString());
  let claimed = 0;
  for (const r of await d.store.listCloudRoutines()) {
    const parsed = parseRoutineSchedule(r.schedule);
    if ("error" in parsed) continue;
    const due = dueOccurrence(parsed.schedule, r.timezone, Date.parse(r.armedAt), now);
    if (!due) continue;
    const scheduledFor = new Date(due.at).toISOString();
    if (await d.store.isClaimed(r.id, scheduledFor)) continue;
    if (await d.store.hasRunningRun(r.id)) {
      // Claimed as a skip, so the occurrence is settled: no later tick runs it.
      await d.store.claimRun({
        routineId: r.id,
        trigger: due.trigger,
        scheduledFor,
        status: "skipped",
        errorCode: "routine_previous_running",
        errorMessage: "the previous run of this routine was still running",
      });
      continue;
    }
    const runId = await d.store.claimRun({ routineId: r.id, trigger: due.trigger, scheduledFor });
    if (!runId) continue;
    if (parsed.schedule.kind === "once") await d.store.disableRoutine(r.id);
    await d.dispatch(runId);
    claimed++;
  }
  return { claimed, stale };
}

// ── run-now: the author's button ──────────────────────────────────────────────

export async function runNow(d: Deps, caller: Caller, routineId: string): Promise<Record<string, unknown>> {
  const r = await d.store.getRoutine(routineId);
  if (!r || !(await caller.isMember(r.workspaceId))) throw new RunFailure("not_found", "routine not found");
  if (r.runner !== "cloud") throw new RunFailure("not_cloud", "this routine runs on its author's computer, not in the cloud");
  if (r.createdBy !== caller.userId) throw new RunFailure("not_author", "only the author of a routine can run it");
  if (await d.store.hasRunningRun(r.id)) throw new RunFailure("busy", "this routine is already running");
  const runId = await d.store.claimRun({ routineId: r.id, trigger: "manual" });
  if (!runId) throw new RunFailure("busy", "the run could not be started");
  await d.dispatch(runId);
  return d.store.runRow(runId);
}

// ── run: do one claimed run ───────────────────────────────────────────────────

export async function executeRun(d: Deps, runId: string): Promise<RunResult | undefined> {
  const run = await d.store.getRun(runId);
  if (!run || run.status !== "running") return undefined;
  const deadline = d.now() + d.runBudgetMs;
  let result: RunResult;
  try {
    const routine = await d.store.getRoutine(run.routineId);
    if (!routine) throw new RunFailure("routine_cloud_unconfigured", "the routine is gone", { missing: "routine" });
    const date = routineLocalDate(Date.parse(run.scheduledFor ?? run.startedAt), routine.timezone);
    result = await perform(d, routine, date, deadline);
  } catch (e) {
    result =
      e instanceof RunFailure
        ? { status: e.skip ? "skipped" : "failed", errorCode: e.code, errorMessage: e.message, errorParams: e.params }
        : { status: "failed", errorMessage: e instanceof Error ? e.message : String(e) };
  }
  await d.store.finishRun(runId, result);
  return result;
}

async function perform(d: Deps, r: CloudRoutine, date: string, deadline: number): Promise<RunResult> {
  // An agent card needs nothing but the database: the cloud cannot run the agent, so the card
  // waits in the author's «Задачі» for them to launch it.
  if (r.action.kind === "prompt" && r.projectId) {
    const taskId = await d.store.insertTask({
      projectId: r.projectId,
      title: `${r.name} · ${date}`,
      description: r.action.prompt,
      ...(r.createdBy ? { assigneeId: r.createdBy, createdBy: r.createdBy } : {}),
      hidden: r.action.hideFromBoard === true,
    });
    return { status: "succeeded", taskId };
  }

  const secrets = (await d.store.getSecrets(r.workspaceId)) ?? {};
  const missing = [
    ...(secrets.anthropicApiKey && secrets.anthropicModel ? [] : ["Anthropic API key"]),
    ...(secrets.githubToken ? [] : ["GitHub token"]),
    ...(r.slack && !secrets.slackBotToken ? ["Slack bot token"] : []),
  ];
  if (missing.length)
    throw new RunFailure("routine_cloud_unconfigured", `the cloud runner is missing: ${missing.join(", ")}`, { missing: missing.join(", ") });
  const gh = new GitHub(secrets.githubToken!, d.fetch);
  const projects = await d.store.listProjects(r.workspaceId);
  const workspaceName = await d.store.workspaceName(r.workspaceId);
  const model = { apiKey: secrets.anthropicApiKey!, model: secrets.anthropicModel!, deadline, now: d.now, fetchFn: d.fetch };

  let produced: Omit<RunResult, "status">;
  let markdown: string;
  if (r.action.kind === "release_notes") {
    const written = await releaseNotes(gh, model, r, r.action, projects, workspaceName, date);
    const noteId = await d.store.insertReleaseNote({ workspaceId: r.workspaceId, ...written.note, ...(r.createdBy ? { createdBy: r.createdBy } : {}) });
    produced = { noteId, commitCount: written.commitCount };
    markdown = written.note.bodyMd;
  } else {
    const repos = new Map<string, GitHubRepo & { ref: string }>();
    for (const p of projects) {
      const repo = parseGitHubRemote(p.gitRemoteUrl);
      if (repo) repos.set(p.name, { ...repo, ref: p.defaultBranch || "HEAD" });
    }
    const { tools, call } = githubTools(gh, repos);
    markdown = await runModel({
      ...model,
      tools,
      call,
      prompt: buildRoutineReportPrompt({
        workspaceName,
        routineName: r.name,
        date,
        timezone: r.timezone,
        repos: projects.map((p) => {
          const repo = repos.get(p.name);
          return { name: p.name, location: repo ? `GitHub ${repo.owner}/${repo.repo}` : "", ...(p.defaultBranch ? { defaultBranch: p.defaultBranch } : {}) };
        }),
        howToRead: "Open them with the list_files, read_file and search_code tools, naming a repository by its name below.",
        instructions: r.action.prompt,
        ...(r.slack ? { slackChannel: r.slack.channelName } : {}),
      }),
    });
    produced = { outputMd: markdown };
  }

  if (!r.slack) return { status: "succeeded", ...produced };
  try {
    if (secrets.slackTeamId && secrets.slackTeamId !== r.slack.teamId)
      throw new Error(`#${r.slack.channelName} is in another Slack workspace than the workspace's bot`);
    await postDocument(secrets.slackBotToken!, r.slack.channelId, markdown, d.fetch);
    return { status: "succeeded", ...produced, slackChannelName: r.slack.channelName };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // `not_in_channel` is the one a person can fix: invite the bot.
    const said = reason === "not_in_channel" ? "the bot is not in the channel — invite it with /invite" : reason;
    return { status: "failed", ...produced, errorCode: "routine_slack_failed", errorMessage: said, errorParams: { channel: r.slack.channelName, reason: said } };
  }
}

async function releaseNotes(
  gh: GitHub,
  model: { apiKey: string; model: string; deadline: number; now: () => number; fetchFn: typeof fetch },
  r: CloudRoutine,
  action: Extract<CloudAction, { kind: "release_notes" }>,
  projects: CloudProject[],
  workspaceName: string,
  date: string,
) {
  const { rangeFrom, rangeTo } = releaseRangeFor(date, action.periodDays);
  // The range's instants on the routine's clock: from the first minute of its first day to the
  // end of its last.
  const [fy, fm, fd] = rangeFrom.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = rangeTo.split("-").map(Number) as [number, number, number];
  const since = new Date(zonedInstant(fy, fm, fd, 0, 0, r.timezone)).toISOString();
  const until = new Date(zonedInstant(ty, tm, td, 23, 59, r.timezone) + 59_999).toISOString();

  const sources = [];
  const repos = new Map<string, GitHubRepo & { ref: string }>();
  let quiet: RunFailure | undefined;
  for (const s of action.sources) {
    const p = projects.find((x) => x.id === s.projectId);
    if (!p) throw new RunFailure("routine_github_failed", "a project of the routine is gone", { project: s.projectId, reason: "the project was deleted" });
    const repo = parseGitHubRemote(p.gitRemoteUrl);
    if (!repo) throw new RunFailure("routine_github_remote", `«${p.name}» has no GitHub remote`, { project: p.name });
    const commits = await gh.commits(repo, s.branch, since, until, r.timezone);
    // The scheduled rule (ReleaseNotesService.generateScheduled): a quiet project drops out,
    // and only a period without commits anywhere is skipped.
    if (commits.length === 0) {
      quiet ??= new RunFailure(
        "no_commits_in_range",
        `«${p.name}» has no commits on branch «${s.branch}» in ${rangeFrom} — ${rangeTo}`,
        { project: p.name, branch: s.branch, from: rangeFrom, to: rangeTo },
        true,
      );
      continue;
    }
    repos.set(p.name, { ...repo, ref: s.branch });
    sources.push({ projectId: p.id, projectName: p.name, branch: s.branch, repoPath: `${repo.owner}/${repo.repo}`, commits });
  }
  if (sources.length === 0) throw quiet!;

  const { tools, call } = githubTools(gh, repos);
  const text = await runModel({
    ...model,
    tools,
    call,
    prompt: buildReleaseNotesPrompt({ workspaceName, sources, rangeFrom, rangeTo, groupBy: action.groupBy ?? "topic", codeAccess: "github" }),
  });
  const names = sources.map((s) => s.projectName).join(" + ");
  return {
    commitCount: sources.reduce((n, s) => n + s.commits.length, 0),
    note: {
      sources: sources.map(({ projectId, projectName, branch }) => ({ projectId, projectName, branch })),
      rangeFrom,
      rangeTo,
      title: titleOf(text, `Release notes: ${names} · ${rangeFrom} — ${rangeTo}`),
      bodyMd: text,
    },
  };
}

// ── the workspace's cloud runner settings ─────────────────────────────────────

export type CloudStatus = {
  isOwner: boolean;
  configured: boolean;
  anthropic: boolean;
  model?: string;
  models: string[];
  github: boolean;
  repos: { projectId: string; projectName: string; repo?: string; ok: boolean; reason?: string }[];
  slack?: { teamId: string; teamName: string };
};

export async function status(d: Deps, caller: Caller, workspaceId: string): Promise<CloudStatus> {
  if (!(await caller.isMember(workspaceId))) throw new RunFailure("not_found", "workspace not found");
  const isOwner = await caller.isOwner(workspaceId);
  const s = (await d.store.getSecrets(workspaceId)) ?? {};
  const gh = s.githubToken ? new GitHub(s.githubToken, d.fetch) : undefined;
  const repos = [];
  for (const p of await d.store.listProjects(workspaceId)) {
    const repo = parseGitHubRemote(p.gitRemoteUrl);
    const where = repo ? `${repo.owner}/${repo.repo}` : undefined;
    if (!repo) repos.push({ projectId: p.id, projectName: p.name, ok: false, reason: "not a GitHub remote" });
    else if (!gh) repos.push({ projectId: p.id, projectName: p.name, repo: where, ok: false, reason: "no GitHub token" });
    else repos.push({ projectId: p.id, projectName: p.name, repo: where, ...(await gh.canRead(repo)) });
  }
  let models: string[] = [];
  if (isOwner && s.anthropicApiKey) models = await listModels(s.anthropicApiKey, d.fetch).catch(() => []);
  return {
    isOwner,
    configured: !!(s.anthropicApiKey && s.anthropicModel && s.githubToken),
    anthropic: !!s.anthropicApiKey,
    ...(s.anthropicModel ? { model: s.anthropicModel } : {}),
    models,
    github: !!s.githubToken,
    repos,
    ...(s.slackBotToken && s.slackTeamId ? { slack: { teamId: s.slackTeamId, teamName: s.slackTeamName ?? "" } } : {}),
  };
}

export type CloudConfig = { anthropicApiKey?: string; anthropicModel?: string; githubToken?: string; slackBotToken?: string };

// Owner only. Every key is tried against its own service before it is stored, so a typo is a
// refusal now rather than a failed run on Monday morning. Absent = keep, "" = remove.
export async function configure(d: Deps, caller: Caller, workspaceId: string, c: CloudConfig): Promise<CloudStatus> {
  if (!(await caller.isOwner(workspaceId))) throw new RunFailure("not_owner", "only the workspace owner sets up the cloud runner");
  const stored = (await d.store.getSecrets(workspaceId)) ?? {};
  const patch: CloudSecrets = {};

  const key = c.anthropicApiKey === undefined ? stored.anthropicApiKey : c.anthropicApiKey.trim();
  if (c.anthropicApiKey !== undefined) patch.anthropicApiKey = key ?? "";
  if (key) {
    let models: string[];
    try {
      models = await listModels(key, d.fetch);
    } catch (e) {
      throw new RunFailure("invalid", `Anthropic refused the key: ${e instanceof Error ? e.message : e}`);
    }
    const wanted = c.anthropicModel?.trim() || (models.includes(stored.anthropicModel ?? "") ? stored.anthropicModel : undefined) || defaultModel(models);
    if (!wanted || !models.includes(wanted)) throw new RunFailure("invalid", `the key has no model «${wanted ?? ""}»`);
    patch.anthropicModel = wanted;
  } else if (c.anthropicApiKey !== undefined) {
    patch.anthropicModel = "";
  }

  if (c.githubToken !== undefined) {
    const token = c.githubToken.trim();
    if (token) {
      try {
        await new GitHub(token, d.fetch).login();
      } catch (e) {
        throw new RunFailure("invalid", `GitHub refused the token: ${e instanceof Error ? e.message : e}`);
      }
    }
    patch.githubToken = token;
  }

  if (c.slackBotToken !== undefined) {
    const token = c.slackBotToken.trim();
    if (token) {
      if (!token.startsWith("xoxb-")) throw new RunFailure("invalid", "a Slack bot token starts with xoxb-");
      try {
        const who = await botIdentity(token, d.fetch);
        patch.slackTeamId = who.teamId;
        patch.slackTeamName = who.teamName;
      } catch (e) {
        throw new RunFailure("invalid", `Slack refused the token: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      patch.slackTeamId = "";
      patch.slackTeamName = "";
    }
    patch.slackBotToken = token;
  }

  await d.store.saveSecrets(workspaceId, patch, caller.userId);
  return status(d, caller, workspaceId);
}

export async function slackChannels(d: Deps, caller: Caller, workspaceId: string): Promise<{ id: string; name: string; isPrivate: boolean }[]> {
  if (!(await caller.isMember(workspaceId))) throw new RunFailure("not_found", "workspace not found");
  const s = await d.store.getSecrets(workspaceId);
  if (!s?.slackBotToken) throw new RunFailure("invalid", "the workspace's Slack bot token is not set");
  return botChannels(s.slackBotToken, d.fetch);
}
