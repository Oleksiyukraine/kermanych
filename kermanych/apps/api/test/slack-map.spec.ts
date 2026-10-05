import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMessage, splitForSlack, threadTranscript, toSlackMrkdwn } from "../src/slack/slack-map";
import { SlackSocket, type SocketLike } from "../src/slack/slack-socket";

const BOT = "UBOT";

describe("classifyMessage", () => {
  const base = { type: "message", channel: "C1", user: "U1" };

  it("treats a top-level message as a question answered in its own thread", () => {
    expect(classifyMessage({ ...base, ts: "100.1", text: "How do refunds work?" }, BOT)).toEqual({
      kind: "question",
      channel: "C1",
      threadTs: "100.1",
      ts: "100.1",
      text: "How do refunds work?",
    });
  });

  it("ignores a thread reply that does not mention the bot", () => {
    expect(classifyMessage({ ...base, ts: "101.0", thread_ts: "100.1", text: "thanks!" }, BOT)).toBeNull();
  });

  it("turns a mentioning thread reply into a follow-up on the root thread, mention stripped", () => {
    const ask = classifyMessage({ ...base, ts: "102.0", thread_ts: "100.1", text: "<@UBOT> and on mobile?" }, BOT);
    expect(ask).toMatchObject({ kind: "followup", threadTs: "100.1", ts: "102.0", text: "and on mobile?" });
  });

  it("accepts the labelled mention form", () => {
    const ask = classifyMessage({ ...base, ts: "102.0", thread_ts: "100.1", text: "what about <@UBOT|kermanych> exports" }, BOT);
    expect(ask).toMatchObject({ kind: "followup", text: "what about exports" });
  });

  it("ignores the bot's own messages and other bots", () => {
    expect(classifyMessage({ ...base, user: BOT, ts: "103.0", text: "answer" }, BOT)).toBeNull();
    expect(classifyMessage({ ...base, bot_id: "B9", ts: "103.0", text: "deploy done" }, BOT)).toBeNull();
    expect(classifyMessage({ type: "message", channel: "C1", ts: "103.0", text: "no author" }, BOT)).toBeNull();
  });

  it("ignores edits and other system subtypes", () => {
    expect(
      classifyMessage({ ...base, subtype: "message_changed", ts: "104.0", message: { text: "edited" } }, BOT),
    ).toBeNull();
    expect(classifyMessage({ ...base, subtype: "channel_join", ts: "104.0", text: "joined" }, BOT)).toBeNull();
  });

  it("still answers a top-level file share", () => {
    expect(classifyMessage({ ...base, subtype: "file_share", ts: "105.0", text: "is this screen documented?" }, BOT))
      .toMatchObject({ kind: "question" });
  });

  it("ignores a mention with nothing else in it", () => {
    expect(classifyMessage({ ...base, ts: "106.0", thread_ts: "100.1", text: "  <@UBOT>  " }, BOT)).toBeNull();
    expect(classifyMessage({ ...base, ts: "106.0", text: "<@UBOT>" }, BOT)).toBeNull();
  });
});

describe("threadTranscript", () => {
  const thread = [
    { user: "U1", ts: "1.0", text: "How do refunds work?" },
    { user: BOT, bot_id: "B1", ts: "2.0", text: "Refunds are issued from *Orders*." },
    { user: "U2", ts: "3.0", text: "<@UBOT> partial ones too?" },
    { user: BOT, bot_id: "B1", ts: "4.0", text: "_Looking through the documentation…_" },
  ];

  it("labels the bot and people, strips the bot mention, and drops the excluded placeholder", () => {
    expect(threadTranscript(thread, BOT, "4.0")).toEqual([
      { who: "<@U1>", text: "How do refunds work?" },
      { who: "Kermanych", text: "Refunds are issued from *Orders*." },
      { who: "<@U2>", text: "partial ones too?" },
    ]);
  });
});

describe("toSlackMrkdwn", () => {
  it("converts bold, headings and links", () => {
    expect(toSlackMrkdwn("## Refunds\nUse **Orders** or __Billing__, see [the guide](https://x.io/g).")).toBe(
      "*Refunds*\nUse *Orders* or *Billing*, see <https://x.io/g|the guide>.",
    );
  });

  it("leaves code spans and fenced blocks untouched", () => {
    const md = "Run `a **b**` now\n```\n# not a heading\n**raw**\n```\n# Done";
    expect(toSlackMrkdwn(md)).toBe("Run `a **b**` now\n```\n# not a heading\n**raw**\n```\n*Done*");
  });
});

describe("splitForSlack", () => {
  const fences = (s: string): number => s.split("\n").filter((l) => l.trimStart().startsWith("```")).length;

  it("keeps an answer that fits as one message", () => {
    expect(splitForSlack("Short.\n\nAnswer.", 100)).toEqual(["Short.\n\nAnswer."]);
  });

  it("breaks between paragraphs, losing nothing", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(10).trim()}`);
    const parts = splitForSlack(paras.join("\n\n"), 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join("\n\n")).toBe(paras.join("\n\n"));
  });

  it("closes a code block it cuts and reopens it in the next message", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const parts = splitForSlack(`Intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro`, 120);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(120);
      expect(fences(p) % 2).toBe(0);
    }
    const body = parts.join("\n").split("\n").filter((l) => /^line \d+$/.test(l));
    expect(body).toEqual(code.split("\n"));
  });

  it("cuts an overlong line at a space, never inside a link", () => {
    const line = `${"alpha ".repeat(15)}<https://example.com/a/very/long/path|the guide> ${"beta ".repeat(15)}`.trim();
    const parts = splitForSlack(line, 200);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(p.split("<").length).toBe(p.split(">").length);
    }
    expect(parts.join("")).toBe(line);
  });
});

// A scripted WebSocket: frames are pushed with `emit`, everything the socket sends is
// recorded in the same `log` the event handler writes to, so ordering is observable.
class FakeSocket implements SocketLike {
  static last: FakeSocket | undefined;
  static opened = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.last = this;
    FakeSocket.opened++;
  }
  send(data: string): void {
    log.push(`ack ${(JSON.parse(data) as { envelope_id: string }).envelope_id}`);
  }
  close(): void {
    this.closed = true;
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let log: string[] = [];
const quiet = { log: () => {}, warn: () => {} };

async function connected(onEvent: (e: unknown, id: string) => void): Promise<{ socket: SlackSocket; ws: FakeSocket }> {
  const socket = new SlackSocket(async () => "wss://slack.test/link", onEvent, { WebSocketImpl: FakeSocket, log: quiet });
  socket.start();
  await vi.waitFor(() => expect(FakeSocket.last).toBeDefined());
  const ws = FakeSocket.last!;
  ws.emit({ type: "hello" });
  return { socket, ws };
}

describe("SlackSocket", () => {
  afterEach(() => {
    log = [];
    FakeSocket.last = undefined;
    FakeSocket.opened = 0;
    vi.useRealTimers();
  });

  const envelope = (envelopeId: string, eventId: string) => ({
    type: "events_api",
    envelope_id: envelopeId,
    payload: { event_id: eventId, event: { type: "message", text: eventId } },
  });

  it("acknowledges an envelope before handing its event over", async () => {
    const { socket, ws } = await connected((_e, id) => log.push(`handle ${id}`));
    expect(socket.isOpen()).toBe(true);
    ws.emit(envelope("env1", "Ev1"));
    expect(log).toEqual(["ack env1", "handle Ev1"]);
    socket.stop();
  });

  it("handles a retried event once but still acknowledges every delivery", async () => {
    const { socket, ws } = await connected((_e, id) => log.push(`handle ${id}`));
    ws.emit(envelope("env1", "Ev1"));
    ws.emit(envelope("env2", "Ev1"));
    expect(log).toEqual(["ack env1", "handle Ev1", "ack env2"]);
    socket.stop();
  });

  it("reconnects after an unexpected close, and not after stop()", async () => {
    vi.useFakeTimers();
    const { socket, ws } = await connected(() => {});
    ws.onclose?.();
    expect(socket.isOpen()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.opened).toBe(2);

    socket.stop();
    expect(FakeSocket.last!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.opened).toBe(2);
  });
});
