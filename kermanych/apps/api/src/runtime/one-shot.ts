// apps/api/src/runtime/one-shot.ts
// One prompt, one answer, one dead child — the shape shared by every caller that asks a
// model a single question and has no conversation to keep: the release-notes generator
// and the Slack documentation bot. Extracted from ReleaseNotesService so both bound the
// same two waits with the same errors, and a fix to the frame handling lands in one place.
//
// Deliberately NOT a conversation (no map of live children, no idle TTL): keeping the child
// alive would keep a resident process for a follow-up that arrives, if ever, as a new ask.
import type { AgentRuntimeKind, RpcEvent } from "@kermanych/core";
import { createRuntime } from "./agent-runtime";
import { reduceRpcEvents, sumTurnUsage, type TurnSpend } from "../supervisor/transcript-reducer";
import { limit } from "../management/management-chat.service";
import { CodedError } from "../management/coded-error";

// Same bounds as the management chat, for the same reasons: a start slower than thirty
// seconds is a missing omp, not a slow laptop; and a generation that reads code before it
// writes is honest work for minutes, so only the four-minute mark means «stuck».
const START_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 240_000;

export type OneShotInput = {
  kind: AgentRuntimeKind;
  cwd: string;
  prompt: string;
  tools?: string[];
  noTools?: boolean;
  model?: string;
  appendSystemPrompt?: string;
  // When the caller's request began, so the spend's wall time includes the work before
  // the spawn (git log, retrieval) exactly as the operator experienced it.
  startedAt: number;
};

// The event handling is the management chat's `drive` minus everything conversational: no
// interactive-UI answering is needed because read-only (or no) tools ask no questions the
// prompt has not already forbidden — but a child that tries anyway is simply dropped by the
// timeout, never left hanging a request.
export async function runOneShot(opts: OneShotInput): Promise<{ text: string; spend: TurnSpend }> {
  const rpc = createRuntime(opts.kind, {
    cwd: opts.cwd,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.noTools ? { noTools: true } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  });
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
  rpc.onExit((_code, reason) =>
    reject(new CodedError("omp_exited_during_generation", `omp завершився під час генерації: ${reason}`, { reason })),
  );

  try {
    const startSeconds = Math.round(START_TIMEOUT_MS / 1000);
    await limit(
      rpc.start(),
      START_TIMEOUT_MS,
      new CodedError(
        "omp_launch_timeout",
        `не вдалося запустити omp за ${startSeconds} с — перевірте, що команда omp доступна в PATH`,
        { seconds: startSeconds },
      ),
    );
    rpc.prompt(opts.prompt);
    const genSeconds = Math.round(TURN_TIMEOUT_MS / 1000);
    await limit(
      promise,
      TURN_TIMEOUT_MS,
      new CodedError(
        "generation_timeout",
        `генерація не завершилась за ${genSeconds} с — спробуйте вужчий період або меншу гілку`,
        { seconds: genSeconds },
      ),
    );
  } finally {
    // Success or failure, the child dies here: a leaked omp outlives the request and
    // keeps a provider seat. `limit` abandons promises, it does not kill processes.
    await rpc.stop().catch(() => {});
  }

  // The reduction is the supervisor's, exactly as the chat's: the same frames that build
  // a session transcript build this answer, so a frame that changes meaning changes
  // meaning in one place.
  const { entries } = reduceRpcEvents(events);
  const text = entries
    .filter((e) => e.kind === "assistant_text")
    .map((e) => e.text)
    .join("\n\n")
    .trim();
  if (!text) throw new CodedError("model_no_text", "модель не повернула тексту — спробуйте ще раз");
  return { text, spend: sumTurnUsage(events, opts.startedAt) };
}
