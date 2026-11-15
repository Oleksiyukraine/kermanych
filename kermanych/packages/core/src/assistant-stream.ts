// packages/core/src/assistant-stream.ts
// The streamed answer of the api's chat assistants — ЦУК (`POST /cuk/chat`) and the Менеджмент
// assistant (`POST /management/chat`), docs/specs/2026-11-15-faster-assistant-answers.md
// (decisions 4–8). The response body is NDJSON: any number of `delta` and `step` lines, then
// exactly one `reply` or `error` line. A failure before the stream opens stays an HTTP error.
import type { ApiErrorCode, ApiErrorParams } from "./i18n-codes";
import { MANAGEMENT_ACTION_FENCE } from "./management-actions";

export const ASSISTANT_STREAM_CONTENT_TYPE = "application/x-ndjson";

export type AssistantStreamFrame<R> =
  // Prose as omp writes it, action blocks included: the reader hides them (`visibleProse`).
  | { type: "delta"; text: string }
  // A tool started — only the Менеджмент assistant has tools. `target` is the path or the
  // pattern it was given, already shortened for one line.
  | { type: "step"; tool: string; target?: string }
  // The turn's whole answer, the same object the endpoint returned before it streamed.
  | { type: "reply"; reply: R }
  // The turn failed after the stream opened (timeout, omp exited, «Новий чат» mid-turn).
  | { type: "error"; message: string; code?: ApiErrorCode; params?: ApiErrorParams };

const FENCE_OPEN = "```" + MANAGEMENT_ACTION_FENCE;

// A whole action block on its own lines — the parser's own shape (management-actions.ts
// BLOCK_RE), so what is hidden while streaming is exactly what the parser later cuts.
const CLOSED_BLOCK = new RegExp(
  "^[^\\S\\n]*```" + MANAGEMENT_ACTION_FENCE + "[^\\S\\n]*\\n[\\s\\S]*?\\n?[^\\S\\n]*```[^\\S\\n]*$",
  "gm",
);

// The prose of a reply still being written: closed action blocks cut, an action block still
// open cut from its fence to the end (`acting` says one is being written), and a line that
// is so far only the start of a fence (```kerm…) held back, so raw JSON and a half-typed
// fence never flash on screen. Collapses the hole a cut block leaves, as the parser does.
export function visibleProse(raw: string): { text: string; acting: boolean } {
  let text = raw.replace(CLOSED_BLOCK, "");
  let acting = false;
  const open = openFenceAt(text);
  if (open >= 0) {
    text = text.slice(0, open);
    acting = true;
  } else {
    const lineStart = text.lastIndexOf("\n") + 1;
    const tail = text.slice(lineStart).trimStart();
    // Inside another language's code block a lone ``` is that block's closing fence.
    const insideCode = (text.slice(0, lineStart).match(/^[^\S\n]*```/gm)?.length ?? 0) % 2 === 1;
    if (!insideCode && tail.length > 0 && tail.startsWith("`") && FENCE_OPEN.startsWith(tail)) text = text.slice(0, lineStart);
  }
  return { text: text.replace(/\n{3,}/g, "\n\n").trimEnd(), acting };
}

// Where an action fence that has no closing fence yet starts, or -1. Only a fence at the start
// of a line opens a block — the parser's rule.
function openFenceAt(text: string): number {
  const re = new RegExp("^[^\\S\\n]*```" + MANAGEMENT_ACTION_FENCE + "\\b", "gm");
  let at = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) at = m.index;
  return at;
}
