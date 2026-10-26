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
// The api's half of the feature ends at the markdown: the browser saves the note into
// `workspace_release_notes` under the operator's own JWT (stores/release-notes.ts), the
// same division of labour the risk register uses — the api has no cloud credentials and
// must not grow any.
import { Injectable, Logger } from "@nestjs/common";
import type {
  ReleaseNotesAsk,
  ReleaseNotesAuthorsAsk,
  ReleaseNotesAuthorsReply,
  ReleaseNotesReply,
  ReleaseSource,
  AgentRuntimeKind,
} from "@kermanych/core";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { MANAGEMENT_TOOLS } from "./management-chat.service";
import { CodedError } from "./coded-error";
import {
  buildReleaseNotesPrompt,
  commitsByAuthor,
  MAX_SUBJECT_CHARS,
  subjectsSize,
  type ReleasePromptSource,
} from "./release-notes-prompt";

// The document's title, read from its first `# ` heading — the prompt requires one, but a
// model that ignored the rule must not sink the whole generation, so the fallback restates
// what the note is about in the list's own terms.
export function titleOf(markdown: string, fallback: string): string {
  const m = /^#[^\S\n]+(.+)$/m.exec(markdown);
  return m?.[1]?.trim() || fallback;
}

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
    const startedAt = Date.now();

    // Every source is resolved before the child is spawned: a note over the back-end and the
    // front-end that fails on the second one must not have spent a model turn on the first.
    // In order, so the first refusal the operator reads is about the first project they picked.
    const resolved: ReleasePromptSource[] = [];
    for (const source of ask.sources) {
      const s = await this.read(source, ask.rangeFrom, ask.rangeTo);
      // An empty project refuses the whole note rather than becoming an empty section: an
      // empty range is usually the wrong branch, and that is worth knowing before a model
      // turn. Checked BEFORE the people filter: a project the picked people never touched is
      // a fact about them, not a sign of the wrong branch.
      if (s.commits.length === 0)
        throw new CodedError(
          "no_commits_in_range",
          `у проєкті «${s.projectName}» на гілці «${s.branch}» немає комітів за ${ask.rangeFrom} — ${ask.rangeTo}; реліз-ноти нема з чого писати`,
          { project: s.projectName, branch: s.branch, from: ask.rangeFrom, to: ask.rangeTo },
        );
      resolved.push(s);
    }

    // A per-person report about some of the team: only the picked people's commits reach the
    // prompt, so the roster, the sections and the ceiling below all see exactly them. A
    // project none of them committed to is left out — a back-end developer picked over the
    // back-end and the front-end gets a note about the back-end, not an empty section.
    const picked = ask.groupBy === "person" && ask.authors ? new Set(ask.authors) : undefined;
    const sources = picked
      ? resolved
          .map((s) => ({ ...s, commits: s.commits.filter((c) => picked.has(c.author)) }))
          .filter((s) => s.commits.length > 0)
      : resolved;
    if (sources.length === 0)
      throw new CodedError(
        "no_commits_by_authors",
        `обрані люди не мають комітів у вибраних проєктах за ${ask.rangeFrom} — ${ask.rangeTo}`,
        { from: ask.rangeFrom, to: ask.rangeTo },
      );

    // The note names every commit, so every subject goes into the prompt. A period whose
    // subjects alone overflow the ceiling is refused before the spawn, with the count, rather
    // than written up as a note that has to leave changes out.
    if (sources.reduce((n, s) => n + subjectsSize(s.commits), 0) > MAX_SUBJECT_CHARS) {
      const count = sources.reduce((n, s) => n + s.commits.length, 0);
      throw new CodedError(
        "too_many_commits",
        `комітів за ${ask.rangeFrom} — ${ask.rangeTo}: ${count} — забагато, щоб перелічити кожну зміну в одній нотатці; оберіть коротший період`,
        { count, from: ask.rangeFrom, to: ask.rangeTo },
      );
    }

    const prompt = buildReleaseNotesPrompt({
      workspaceName: ask.workspaceName,
      sources,
      rangeFrom: ask.rangeFrom,
      rangeTo: ask.rangeTo,
      groupBy: ask.groupBy,
      ...(picked ? { authors: [...picked] } : {}),
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

    return {
      title: titleOf(generated.text, `Release notes: ${names} · ${ask.rangeFrom} — ${ask.rangeTo}`),
      markdown: generated.text,
      commitCount: sources.reduce((n, s) => n + s.commits.length, 0),
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it, spawn included.
      ms: Date.now() - startedAt,
    };
  }

  // The people the per-person form offers: every commit author of the period across the
  // asked projects, each on its own branch, with their commit count summed over them. Read
  // exactly the way `generate` reads, so a name offered here is a name it will find. An empty
  // project is not refused here — it simply contributes nobody; generating still refuses it.
  async authors(ask: ReleaseNotesAuthorsAsk): Promise<ReleaseNotesAuthorsReply> {
    const logs: ReleasePromptSource["commits"][] = [];
    for (const source of ask.sources) logs.push((await this.read(source, ask.rangeFrom, ask.rangeTo)).commits);
    return { authors: [...commitsByAuthor(logs.flat())].map(([name, own]) => ({ name, commits: own.length })) };
  }

  // One source → its project's name, checkout and commits. Every refusal names the project:
  // with two projects picked, «the branch is not in the repository» is useless without
  // saying which repository.
  private async read(source: ReleaseSource, from: string, to: string): Promise<ReleasePromptSource> {
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

    const commits = await this.worktree.logRange(project.localRepoPath, source.branch, from, to);

    return { projectName: project.name, branch: source.branch, repoPath: project.localRepoPath, commits };
  }
}
