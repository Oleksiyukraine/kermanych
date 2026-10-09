// apps/api/src/management/release-notes.service.ts
// The release-notes generator: one `omp --mode rpc` child per request, born in the bound
// repository, handed the branch's commits for the chosen date range, dropped as soon as
// the document is back. Same binary, provider account and subscription as every agent —
// the reply's `usage` says what the note cost, exactly like a management chat turn.
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
import type { ReleaseNotesAsk, ReleaseNotesReply, AgentRuntimeKind } from "@kermanych/core";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { MANAGEMENT_TOOLS } from "./management-chat.service";
import { CodedError } from "./coded-error";
import { buildReleaseNotesPrompt } from "./release-notes-prompt";

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

    // The registry, never the client, says where the repo lives — the same rule
    // managementRepos applies. Unbound means unbuildable HERE: generation reads THIS
    // machine's git history, so the error names the machine, not the project.
    const project = this.registry.listProjects().find((p) => p.id === ask.projectId);
    if (!project) throw new CodedError("project_not_in_registry", "проєкт не знайдено в локальному реєстрі");
    if (!project.localRepoPath)
      throw new CodedError(
        "project_not_bound",
        "проєкт не привʼязаний на цій машині — генерація читає git-історію локального репозиторію",
      );

    // The branch must be one of the repo's own: `git log` on an invented name would answer
    // with an error the operator cannot act on, and the UI's picker offers exactly this list.
    const branches = await this.worktree.listBranches(project.localRepoPath);
    if (!branches.includes(ask.branch))
      throw new CodedError("branch_not_in_repo", `гілки «${ask.branch}» немає в локальному репозиторії`, {
        branch: ask.branch,
      });

    const commits = await this.worktree.logRange(project.localRepoPath, ask.branch, ask.rangeFrom, ask.rangeTo);
    if (commits.length === 0)
      throw new CodedError(
        "no_commits_in_range",
        `на гілці «${ask.branch}» немає комітів за ${ask.rangeFrom} — ${ask.rangeTo}; реліз-ноти нема з чого писати`,
        { branch: ask.branch, from: ask.rangeFrom, to: ask.rangeTo },
      );

    const prompt = buildReleaseNotesPrompt({
      workspaceName: ask.workspaceName,
      projectName: project.name,
      branch: ask.branch,
      rangeFrom: ask.rangeFrom,
      rangeTo: ask.rangeTo,
      commits,
      groupBy: ask.groupBy,
    });

    // Deliberately no agent-language append: it tells the model to write every reply in the
    // operator's chosen language, and this child's one reply IS the note, which is always
    // English (release-notes-prompt.ts).
    const generated = await runOneShot({
      kind: this.runtimeFor(),
      cwd: project.localRepoPath,
      prompt,
      tools: [...MANAGEMENT_TOOLS],
      startedAt,
    });
    this.log.debug(`release notes: згенеровано ${generated.text.length} символів у ${project.localRepoPath}`);
    const { usage, model } = generated.spend;

    return {
      title: titleOf(generated.text, `Release notes: ${project.name} · ${ask.rangeFrom} — ${ask.rangeTo}`),
      markdown: generated.text,
      commitCount: commits.length,
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it, spawn included.
      ms: Date.now() - startedAt,
    };
  }
}
