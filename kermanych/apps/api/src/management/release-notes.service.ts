// apps/api/src/management/release-notes.service.ts
// The release-notes generator: one `omp --mode rpc` child per request, born in the first
// bound repository, handed every picked project's commits on its own branch for the chosen
// date range, dropped as soon as the document is back. Same binary, provider account and
// subscription as every agent — the reply's `usage` says what the note cost, exactly like a
// management chat turn.
//
// Deliberately NOT a conversation (no map of live children, no idle TTL): a generation is
// one question with one answer, and keeping the child alive would keep a resident process
// for a follow-up that has nowhere to be typed. Editing the note afterwards is a text
// edit on the screen, not a model turn.
//
// The api's half of an on-screen or chat generation ends at the markdown: the browser saves the
// note into `workspace_release_notes` under the operator's own JWT (stores/release-notes.ts),
// the same division of labour the risk register uses. A ROUTINE's note is stored by the api
// itself (routines/routines.service.ts), under the same JWT, because no browser asked for it.
import { Injectable, Logger } from "@nestjs/common";
import type { ReleaseNotesAsk, ReleaseNotesReply, ReleaseSource, AgentRuntimeKind } from "@kermanych/core";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { MANAGEMENT_TOOLS } from "./management-chat.service";
import { CodedError } from "./coded-error";
import { buildReleaseNotesPrompt, titleOf, type ReleasePromptSource } from "./release-notes-prompt";

// A routine's note (`generateScheduled`): the document and the sources it was written from.
export type ScheduledReleaseNotes = {
  reply: ReleaseNotesReply;
  sources: { projectId: string; projectName: string; branch: string }[];
};

@Injectable()
export class ReleaseNotesService {
  private readonly log = new Logger(ReleaseNotesService.name);

  constructor(
    private registry: RegistryService,
    private worktree: WorktreeService,
  ) {}

  // Per-user preference (Inc 2/3): env override → cached cloud preference → omp. A generation
  // has no sessions row to stamp, so the runtime is resolved fresh for its one-shot child.
  private runtimeFor(): AgentRuntimeKind {
    return resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime);
  }

  async generate(ask: ReleaseNotesAsk): Promise<ReleaseNotesReply> {
    return (await this.write(ask, false)).reply;
  }

  // The scheduled form, for routines (docs/specs/2026-10-16-routines.md). A weekly note over
  // the back-end and the front-end should not be lost because the front-end had a quiet week,
  // so a project without commits in the period drops out of the note; only a period without
  // commits in ANY project is refused (with the first project's `no_commits_in_range`). Answers
  // the sources the note was actually written from, names included, so what is stored as the
  // note's provenance is exactly the sections it has.
  async generateScheduled(ask: ReleaseNotesAsk): Promise<ScheduledReleaseNotes> {
    return this.write(ask, true);
  }

  private async write(ask: ReleaseNotesAsk, skipEmpty: boolean): Promise<ScheduledReleaseNotes> {
    const startedAt = Date.now();

    // Every source is resolved before the child is spawned: a note over the back-end and the
    // front-end that fails on the second one must not have spent a model turn on the first.
    // In order, so the first refusal the operator reads is about the first project they picked.
    const sources: ReleasePromptSource[] = [];
    const used: ScheduledReleaseNotes["sources"] = [];
    let quiet: CodedError | undefined;
    for (const source of ask.sources) {
      try {
        const resolved = await this.resolve(source, ask.rangeFrom, ask.rangeTo);
        sources.push(resolved);
        used.push({ projectId: source.projectId, projectName: resolved.projectName, branch: source.branch });
      } catch (err) {
        if (!skipEmpty || !(err instanceof CodedError) || err.code !== "no_commits_in_range") throw err;
        quiet ??= err;
      }
    }
    if (sources.length === 0) throw quiet!;

    const prompt = buildReleaseNotesPrompt({
      workspaceName: ask.workspaceName,
      sources,
      rangeFrom: ask.rangeFrom,
      rangeTo: ask.rangeTo,
      groupBy: ask.groupBy,
    });

    // Born in the first project's repository. With several projects the prompt names every
    // project's folder, and the read-only tools open any of them by absolute path.
    const cwd = sources[0]!.repoPath;
    // Deliberately no agent-language append: it tells the model to write every reply in the
    // operator's chosen language, and this child's one reply IS the note, which is always
    // English (release-notes-prompt.ts).
    const generated = await runOneShot({
      kind: this.runtimeFor(),
      cwd,
      prompt,
      tools: [...MANAGEMENT_TOOLS],
      startedAt,
    });
    this.log.debug(`release notes: згенеровано ${generated.text.length} символів у ${cwd}`);
    const { usage, model } = generated.spend;
    const names = sources.map((s) => s.projectName).join(" + ");

    const reply: ReleaseNotesReply = {
      title: titleOf(generated.text, `Release notes: ${names} · ${ask.rangeFrom} — ${ask.rangeTo}`),
      markdown: generated.text,
      commitCount: sources.reduce((n, s) => n + s.commits.length, 0),
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it, spawn included.
      ms: Date.now() - startedAt,
    };
    return { reply, sources: used };
  }

  // One source → its project's name, checkout and commits. Every refusal names the project:
  // with two projects picked, «the branch is not in the repository» is useless without
  // saying which repository.
  private async resolve(source: ReleaseSource, from: string, to: string): Promise<ReleasePromptSource> {
    // The registry, never the client, says where the repo lives — the same rule
    // managementRepos applies. Unbound means unbuildable HERE: generation reads THIS
    // machine's git history, so the error names the machine, not the project.
    const project = this.registry.listProjects().find((p) => p.id === source.projectId);
    if (!project) throw new CodedError("project_not_in_registry", "проєкт не знайдено в локальному реєстрі");
    if (!project.localRepoPath)
      throw new CodedError(
        "project_not_bound",
        `проєкт «${project.name}» не привʼязаний на цій машині — генерація читає git-історію локального репозиторію`,
        { project: project.name },
      );

    // The branch must be one of the repo's own: `git log` on an invented name would answer
    // with an error the operator cannot act on, and the UI's picker offers exactly this list.
    const branches = await this.worktree.listBranches(project.localRepoPath);
    if (!branches.includes(source.branch))
      throw new CodedError(
        "branch_not_in_repo",
        `гілки «${source.branch}» немає в локальному репозиторії проєкту «${project.name}»`,
        { project: project.name, branch: source.branch },
      );

    // An empty project refuses the whole note rather than becoming an empty section: an
    // empty range is usually the wrong branch, and that is worth knowing before a model turn.
    const commits = await this.worktree.logRange(project.localRepoPath, source.branch, from, to);
    if (commits.length === 0)
      throw new CodedError(
        "no_commits_in_range",
        `у проєкті «${project.name}» на гілці «${source.branch}» немає комітів за ${from} — ${to}; реліз-ноти нема з чого писати`,
        { project: project.name, branch: source.branch, from, to },
      );

    return { projectName: project.name, branch: source.branch, repoPath: project.localRepoPath, commits };
  }
}
