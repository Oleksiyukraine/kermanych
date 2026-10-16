// routines-runner/anthropic.ts — the cloud runner's model: Anthropic's Messages API with the
// workspace's own key (billed per use), and a bounded tool loop over the read-only GitHub tools.
// The local runner's equivalent is an `omp` one-shot child with read/grep/glob.
//
// Bounded twice: by turns, and by the wall-clock budget of the Edge Function — when either
// runs out, one last turn with `tool_choice: none` makes the model write its answer from what it
// has read so far, so a long investigation ends in a document, not in a timeout.
import { RunFailure } from "./failure.ts";

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";
const MAX_TOKENS = 8_000;
const MAX_TOOL_TURNS = 16;
// Reserved for the final answer: one model turn writing a full document.
const ANSWER_RESERVE_MS = 45_000;

export type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

type Reply = { content: Block[]; stop_reason: string };

function headers(key: string): Record<string, string> {
  return { "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" };
}

// The key's models, newest first — the `configure` check that the key works, and the owner's
// picker.
export async function listModels(key: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const r = await fetchFn(`${API}/models?limit=100`, { headers: headers(key) });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await errorText(r)}`);
  return ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id);
}

// A sensible default for a new key: the newest Sonnet, else the newest model.
export function defaultModel(models: string[]): string | undefined {
  return models.find((m) => m.includes("sonnet")) ?? models[0];
}

export async function runModel(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  tools: ToolSpec[];
  call: (name: string, input: Record<string, unknown>) => Promise<string>;
  deadline: number;
  now?: () => number;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? fetch;
  const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: opts.prompt }];

  for (let turn = 0; ; turn++) {
    const last = turn >= MAX_TOOL_TURNS || now() > opts.deadline - ANSWER_RESERVE_MS || opts.tools.length === 0;
    const res = await fetchFn(`${API}/messages`, {
      method: "POST",
      headers: headers(opts.apiKey),
      body: JSON.stringify({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        messages,
        ...(opts.tools.length ? { tools: opts.tools } : {}),
        ...(last && opts.tools.length ? { tool_choice: { type: "none" } } : {}),
      }),
    });
    if (!res.ok) throw new RunFailure("routine_model_failed", `Anthropic ${res.status}`, { reason: `Anthropic ${res.status}: ${await errorText(res)}` });
    const reply = (await res.json()) as Reply;
    const uses = reply.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (last || reply.stop_reason !== "tool_use" || uses.length === 0) {
      const text = reply.content
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim();
      if (!text) throw new RunFailure("routine_model_failed", "the model returned no text", { reason: "the model returned no text" });
      return text;
    }
    messages.push({ role: "assistant", content: reply.content });
    const results = [];
    for (const u of uses) {
      let content: string;
      try {
        content = await opts.call(u.name, u.input ?? {});
      } catch (e) {
        content = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content });
    }
    messages.push({ role: "user", content: results });
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    return j.error?.message ?? r.statusText;
  } catch {
    return r.statusText;
  }
}
