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
import type { ReleaseNotesAsk, ReleaseNotesReply, RpcEvent } from "@kermanych/core";
import { RELEASE_PLATFORM_LABELS } from "@kermanych/core";
import { RpcSession } from "../rpc/rpc-session";
import { RegistryService } from "../registry/registry.service";
import { WorktreeService } from "../worktree/worktree.service";
import { reduceRpcEvents, sumTurnUsage, type TurnSpend } from "../supervisor/transcript-reducer";
import { limit, MANAGEMENT_TOOLS } from "./management-chat.service";
import { buildReleaseNotesPrompt } from "./release-notes-prompt";

// Same bounds as the management chat, for the same reasons: a start slower than thirty
// seconds is a missing omp, not a slow laptop; and a generation that reads code before it
// writes is honest work for minutes, so only the four-minute mark means «stuck».
const START_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 240_000;

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

  async generate(ask: ReleaseNotesAsk): Promise<ReleaseNotesReply> {
    const startedAt = Date.now();

    // The registry, never the client, says where the repo lives — the same rule
    // managementRepos applies. Unbound means unbuildable HERE: generation reads THIS
    // machine's git history, so the error names the machine, not the project.
    const project = this.registry.listProjects().find((p) => p.id === ask.projectId);
    if (!project) throw new Error("проєкт не знайдено в локальному реєстрі");
    if (!project.localRepoPath)
      throw new Error("проєкт не привʼязаний на цій машині — генерація читає git-історію локального репозиторію");

    // The branch must be one of the repo's own: `git log` on an invented name would answer
    // with an error the operator cannot act on, and the UI's picker offers exactly this list.
    const branches = await this.worktree.listBranches(project.localRepoPath);
    if (!branches.includes(ask.branch))
      throw new Error(`гілки «${ask.branch}» немає в локальному репозиторії`);

    const commits = await this.worktree.logRange(project.localRepoPath, ask.branch, ask.rangeFrom, ask.rangeTo);
    if (commits.length === 0)
      throw new Error(
        `на гілці «${ask.branch}» немає комітів за ${ask.rangeFrom} — ${ask.rangeTo}; реліз-ноти нема з чого писати`,
      );

    const prompt = buildReleaseNotesPrompt({
      workspaceName: ask.workspaceName,
      projectName: project.name,
      platform: ask.platform,
      branch: ask.branch,
      rangeFrom: ask.rangeFrom,
      rangeTo: ask.rangeTo,
      commits,
    });

    const generated = await this.oneShot(project.localRepoPath, prompt, startedAt);
    const { usage, model } = generated.spend;

    return {
      title: titleOf(
        generated.text,
        `Реліз-ноти ${RELEASE_PLATFORM_LABELS[ask.platform]} · ${ask.rangeFrom} — ${ask.rangeTo}`,
      ),
      markdown: generated.text,
      commitCount: commits.length,
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      // Wall time as the operator experienced it, spawn included.
      ms: Date.now() - startedAt,
    };
  }

  // One prompt, one answer, one dead child. The event handling is the management chat's
  // `drive` minus everything conversational: no interactive-UI answering is needed because
  // read-only tools ask no questions the prompt has not already forbidden — but a child
  // that tries anyway is simply dropped by the timeout, never left hanging a request.
  private async oneShot(cwd: string, prompt: string, startedAt: number): Promise<{ text: string; spend: TurnSpend }> {
    const rpc = new RpcSession({ cwd, tools: [...MANAGEMENT_TOOLS] });
    const events: RpcEvent[] = [];
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    rpc.onEvent((e) => {
      events.push(e);
      if (e.type === "agent_end") {
        // `isTerminal: false` marks a sub-agent's end, not the answer's.
        const isTerminal = "isTerminal" in e ? e.isTerminal : undefined;
        if (isTerminal !== false) resolve();
      }
    });
    rpc.onExit((_code, reason) => reject(new Error(`omp завершився під час генерації: ${reason}`)));

    try {
      await limit(
        rpc.start(),
        START_TIMEOUT_MS,
        `не вдалося запустити omp за ${Math.round(START_TIMEOUT_MS / 1000)} с — перевірте, що команда omp доступна в PATH`,
      );
      rpc.prompt(prompt);
      await limit(
        promise,
        TURN_TIMEOUT_MS,
        `генерація не завершилась за ${Math.round(TURN_TIMEOUT_MS / 1000)} с — спробуйте вужчий період або меншу гілку`,
      );
    } finally {
      // Success or failure, the child dies here: a leaked omp outlives the request and
      // keeps a provider seat. `limit` abandons promises, it does not kill processes.
      await rpc.stop().catch(() => {});
    }

    // The reduction is the supervisor's, exactly as the chat's: the same frames that build
    // a session transcript build this document, so a frame that changes meaning changes
    // meaning in one place.
    const { entries } = reduceRpcEvents(events);
    const text = entries
      .filter((e) => e.kind === "assistant_text")
      .map((e) => e.text)
      .join("\n\n")
      .trim();
    if (!text) throw new Error("модель не повернула тексту — спробуйте ще раз");
    this.log.debug(`release notes: згенеровано ${text.length} символів у ${cwd}`);
    return { text, spend: sumTurnUsage(events, startedAt) };
  }
}
