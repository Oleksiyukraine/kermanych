// apps/api/src/supervisor/branch-name.service.ts
// Names an agent's branch from what its task is about (docs/specs/2026-10-26-branch-name-from-task.md):
// one tool-less one-shot child on the operator's runtime reads the task's title and description
// and answers with a short English slug. The prefix (`feature`, `fix`, …) stays the card's.
//
// Never a reason to refuse a launch: every failure — no runtime, a timeout, a model error, an
// answer with no usable slug — is logged and answered with `undefined`, and the supervisor
// falls back to the transliterated title.
import { homedir } from "os";
import { Injectable, Logger } from "@nestjs/common";
import { slugify, type AgentRuntimeKind } from "@kermanych/core";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { RegistryService } from "../registry/registry.service";

export type BranchContext = { title: string; description?: string };

// The operator waits on «Запустити» for this answer, so it is bounded far below the chat's
// minutes: a fast model answers a slug in a couple of seconds.
const START_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 15_000;
// A long card body says nothing more about its branch than its first screens do.
const MAX_DESCRIPTION_CHARS = 4_000;

// The cheap model of each runtime. `pi/smol` is omp's configured smol role, whatever provider
// the operator set it to; claude takes the `haiku` alias.
const FAST_MODEL: Record<AgentRuntimeKind, string> = { omp: "pi/smol", "claude-code": "haiku" };

export function branchNamePrompt(ctx: BranchContext): string {
  const description = (ctx.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS);
  return [
    "Name the git branch for the task below.",
    "",
    "Rules:",
    "- Answer with the branch slug only: one line, nothing before or after it.",
    "- English, lowercase, words joined with hyphens: only a-z, 0-9 and -.",
    "- 2 to 5 words, at most 40 characters, saying what the change is (e.g. add-oauth-login, fix-csv-export-encoding).",
    "- Translate a task written in another language; never transliterate it.",
    "- No prefix such as feature/ or fix/, no ticket numbers, no quotes.",
    "",
    "<task-title>",
    ctx.title.trim(),
    "</task-title>",
    ...(description && description !== ctx.title.trim() ? ["<task-description>", description, "</task-description>"] : []),
  ].join("\n");
}

// The model's answer as a slug, or undefined when there is none worth using. Not trusted: the
// first non-empty line, backticks and quotes dropped, anything up to the last `/` dropped (a
// model that writes `feature/…` anyway), then slugify's own rules and cap. A result with no
// letter or digit — slugify's «session» for an empty one — is no answer.
export function modelBranchSlug(text: string): string | undefined {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const bare = line.replace(/[`"'*]/g, "").split("/").pop() ?? "";
  if (!/[a-z0-9]/i.test(bare)) return undefined;
  return slugify(bare);
}

@Injectable()
export class BranchNameService {
  private readonly log = new Logger(BranchNameService.name);

  constructor(private registry: RegistryService) {}

  async suggest(ctx: BranchContext): Promise<string | undefined> {
    if (!ctx.title.trim() && !ctx.description?.trim()) return undefined;
    const kind = resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime);
    try {
      const { text } = await runOneShot({
        kind,
        // No tools, so no repository: the home directory keeps the project's rules and
        // instructions out of a prompt that needs none of them.
        cwd: homedir(),
        prompt: branchNamePrompt(ctx),
        noTools: true,
        model: FAST_MODEL[kind],
        startedAt: Date.now(),
        startTimeoutMs: START_TIMEOUT_MS,
        turnTimeoutMs: TURN_TIMEOUT_MS,
      });
      const slug = modelBranchSlug(text);
      if (!slug) this.log.warn(`no branch slug in the model's answer ${JSON.stringify(text.slice(0, 200))}; using the title`);
      return slug;
    } catch (err) {
      this.log.warn(`branch name generation failed (${(err as Error).message}); using the title`);
      return undefined;
    }
  }
}
