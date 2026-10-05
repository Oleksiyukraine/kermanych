// apps/api/src/slack/slack-map.ts
// The tolerant boundary between Slack's message shapes and the bot's decisions — pure
// functions, so the rules «what is a question», «what is a follow-up» and «what does the
// thread look like to the model» are testable without a socket or a model.
import type { SlackRawMessage } from "./slack-client";

export type SlackAsk = {
  kind: "question" | "followup";
  channel: string;
  // The thread the answer goes into: the question's own ts for a top-level message, the
  // root's ts for a follow-up.
  threadTs: string;
  ts: string;
  text: string;
};

// Plain messages, replies also sent to the channel, and messages with an attachment are
// things a person typed. Every other subtype is an edit (`message_changed`), a deletion,
// a join notice or a bot post — none of them is a question.
const HUMAN_SUBTYPES = new Set<string | undefined>([undefined, "thread_broadcast", "file_share"]);

// Slack renders a mention as `<@U123>` and occasionally as `<@U123|name>`.
function mentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
}

function stripMention(text: string, botUserId: string): string {
  return text.replace(mentionPattern(botUserId), " ").replace(/[ \t]{2,}/g, " ").trim();
}

// What one Events API message means for the bot. Every top-level message in the bound
// channel is a question; inside a thread only a message that @-mentions the bot is
// addressed to it — the rest is people talking to each other.
export function classifyMessage(event: unknown, botUserId: string): SlackAsk | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Partial<SlackRawMessage> & { type?: string; channel?: string };
  if (e.type !== "message" || !HUMAN_SUBTYPES.has(e.subtype)) return null;
  // The bot's own replies arrive as events too; answering them would be a loop.
  if (e.bot_id || !e.user || e.user === botUserId) return null;
  if (typeof e.channel !== "string" || typeof e.ts !== "string") return null;

  const raw = e.text ?? "";
  const topLevel = !e.thread_ts || e.thread_ts === e.ts;
  if (!topLevel && !mentionPattern(botUserId).test(raw)) return null;

  const text = stripMention(raw, botUserId);
  if (!text) return null;
  return {
    kind: topLevel ? "question" : "followup",
    channel: e.channel,
    threadTs: topLevel ? e.ts : e.thread_ts!,
    ts: e.ts,
    text,
  };
}

export type TranscriptLine = { who: string; text: string };

// The thread as the model reads it, in order. People stay `<@U…>` — the bot holds no
// users:read scope to resolve names, and the raw mention is still a stable «who said what».
// `excludeTs` drops the placeholder the bot just posted for the very answer being written.
export function threadTranscript(messages: SlackRawMessage[], botUserId: string, excludeTs?: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const m of messages) {
    if (m.ts === excludeTs) continue;
    const text = stripMention(m.text ?? "", botUserId);
    if (!text) continue;
    const isBot = !!m.bot_id || m.user === botUserId;
    out.push({ who: isBot ? "Kermanych" : `<@${m.user ?? "unknown"}>`, text });
  }
  return out;
}

// The inline conversions, applied only outside backtick code spans: a span is literal in
// both dialects, and `**` inside one is code, not emphasis. Links go first, so a bold link
// text keeps its link, then both bold spellings onto Slack's single asterisk.
function outsideCodeSpans(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\[([^\]]+)\]\((\S+?)\)/g, "<$2|$1>")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "*$1*"),
    )
    .join("");
}

// Models write CommonMark; Slack renders its own mrkdwn, where `**x**` shows asterisks,
// `#` is a literal hash and `[t](url)` is not a link. Only those three are converted —
// lists, quotes and code read the same in both — and fenced blocks pass through untouched.
export function toSlackMrkdwn(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        // Slack has no headings; a bold line is the convention. Emphasis already inside the
        // heading is dropped so it does not toggle the bold off halfway.
        const inner = outsideCodeSpans(heading[1]!.replace(/\*\*|__/g, ""));
        return inner ? `*${inner}*` : "";
      }
      return outsideCodeSpans(line);
    })
    .join("\n");
}
