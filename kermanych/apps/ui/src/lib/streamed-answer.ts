// apps/ui/src/lib/streamed-answer.ts
// The streamed answer both chat stores share — ЦУК (stores/cuk-chat.ts) and the Менеджмент
// assistant (stores/management-chat.ts), docs/specs/2026-11-15-faster-assistant-answers.md.
// The assistant entry appears with the first delta and grows with each one; its text is
// `visibleProse` of what arrived, so a half-written action block shows as «готую дію…»
// (`acting`) rather than raw JSON. The reply then replaces it with the parsed prose; a turn
// that broke or was stopped keeps what was written, marked (`cut`).
import { visibleProse, type Usage } from '@kermanych/core';

export type AssistantCut = 'broken' | 'stopped';

export type AssistantTurnEntry = {
  kind: 'assistant';
  id: string;
  at: number;
  text: string;
  model?: string;
  usage?: Usage;
  ms: number;
  // Deltas are still arriving.
  streaming?: boolean;
  // An action block is being written below the text.
  acting?: boolean;
  cut?: AssistantCut;
};

// The tool the Менеджмент assistant is running right now (the «Шукаю в коді: …» line).
export type AssistantStep = { tool: string; target?: string };

type ReplyMeta = { text: string; ms: number; model?: string; usage?: Usage; stopped?: true };

export class StreamedAnswer {
  private raw = '';
  private entry: AssistantTurnEntry | undefined;

  // `append` adds the entry to the store's transcript and returns the stored (reactive) copy,
  // which is what later deltas write to.
  constructor(
    private readonly append: (entry: AssistantTurnEntry) => AssistantTurnEntry,
    private readonly newId: () => string,
  ) {}

  delta(text: string): void {
    this.raw += text;
    const { text: visible, acting } = visibleProse(this.raw);
    this.entry ??= this.append({ kind: 'assistant', id: this.newId(), at: Date.now(), text: '', ms: 0, streaming: true });
    this.entry.text = visible;
    this.entry.acting = acting;
  }

  // The turn's reply: the parsed prose and its accounting, on the streamed entry when there is
  // one, as a new entry otherwise (an answer that streamed nothing, e.g. an action alone).
  finish(reply: ReplyMeta): void {
    const done: AssistantTurnEntry = {
      kind: 'assistant',
      id: this.entry?.id ?? this.newId(),
      at: this.entry?.at ?? Date.now(),
      text: reply.text,
      ms: reply.ms,
      ...(reply.model ? { model: reply.model } : {}),
      ...(reply.usage ? { usage: reply.usage } : {}),
      ...(reply.stopped ? { cut: 'stopped' as const } : {}),
    };
    if (!this.entry) {
      // A stopped turn that wrote nothing leaves nothing to show; the mark alone is noise.
      if (reply.text || !reply.stopped) this.append(done);
      return;
    }
    Object.assign(this.entry, done, { streaming: false, acting: false });
  }

  // The turn failed after it started writing: keep the prose, mark it cut off. Nothing to do
  // when nothing streamed — the error line alone says it.
  fail(): void {
    if (!this.entry) return;
    Object.assign(this.entry, { streaming: false, acting: false, cut: 'broken' as const });
  }
}
