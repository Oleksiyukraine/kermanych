// apps/api/src/http/assistant-stream.ts
// The streamed answer both chat endpoints share — `POST /cuk/chat` and `POST /management/chat`
// (docs/specs/2026-11-15-faster-assistant-answers.md, decision 4): NDJSON frames on the same
// request, `delta` / `step` while the turn runs, then one `reply` or one `error`.
//
// The stream opens lazily, on the first frame. A turn that fails before it wrote anything —
// a missing omp, a launch timeout, a validation the service makes — is relayed as the HTTP
// error it always was, so the browser's ordinary error path still sees it. A browser that went
// away mid-turn (a reload) leaves the turn to finish in its child, as before; the frames
// written after that are dropped.
import { ASSISTANT_STREAM_CONTENT_TYPE, type AssistantStreamFrame } from "@kermanych/core";
import type { ChatSink } from "../assistant/rpc-chat-pool";
import { CodedError, relay } from "../management/coded-error";

// The slice of the Node/Express response this needs (the jira controller's idiom: no
// dependency on express's types for four methods).
export type StreamResponse = {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): unknown;
  end(): unknown;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
};

export async function streamTurn<R>(res: StreamResponse, run: (sink: ChatSink) => Promise<R>): Promise<void> {
  let open = false;
  const write = (frame: AssistantStreamFrame<R>): void => {
    if (!open) {
      res.status(200);
      res.setHeader("Content-Type", `${ASSISTANT_STREAM_CONTENT_TYPE}; charset=utf-8`);
      res.setHeader("Cache-Control", "no-cache");
      res.flushHeaders();
      open = true;
    }
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(frame)}\n`);
  };
  const end = (): void => {
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  try {
    const reply = await run({
      delta: (text) => write({ type: "delta", text }),
      step: (tool, target) => write({ type: "step", tool, ...(target === undefined ? {} : { target }) }),
    });
    write({ type: "reply", reply });
    end();
  } catch (err) {
    if (!open) relay(err);
    write(
      err instanceof CodedError
        ? { type: "error", code: err.code, message: err.message, ...(err.params ? { params: err.params } : {}) }
        : { type: "error", message: (err as Error).message },
    );
    end();
  }
}
