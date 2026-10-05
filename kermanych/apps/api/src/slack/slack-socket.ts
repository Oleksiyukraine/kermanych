// apps/api/src/slack/slack-socket.ts
// One Socket Mode connection for one Slack app. Socket Mode is the reason the bot works at
// all: the api binds 127.0.0.1, so Slack cannot POST events to it — instead the api dials
// OUT to a wss:// URL minted by `apps.connections.open` and Slack pushes events down it.
//
// The protocol, as much of it as the bot needs:
//   • `hello`      — the connection is live; only now does it count as listening.
//   • every frame with an `envelope_id` must be acknowledged with `{ envelope_id }` within
//     three seconds or Slack retries it — so the ack goes out BEFORE the event is handled,
//     because handling means an LLM answer that takes far longer than three seconds.
//   • `events_api` — one Events API payload; `payload.event` is the message.
//   • `disconnect` — Slack is about to drop this connection (refresh, maintenance); open a
//     fresh one now rather than waiting for the close.
// Node's global WebSocket (undici) is the transport: no `ws`, no SDK.
import { Logger } from "@nestjs/common";

// Slack retries an unacknowledged envelope (and occasionally redelivers an acknowledged
// one) with the same event_id. The handler posts to Slack, so a duplicate would be a
// duplicate answer. A few hundred ids is minutes of a busy channel — far past any retry.
const SEEN_EVENT_IDS = 500;

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// The slice of the WebSocket API this file uses. Declared here rather than typed as the
// global so a spec can hand in a scripted fake without implementing undici's whole surface;
// the global is cast to it once, below.
export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
export type SocketCtor = new (url: string) => SocketLike;

type Frame = {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: { event?: unknown; event_id?: string };
};

export class SlackSocket {
  private ws: SocketLike | undefined;
  private ready = false;
  private started = false;
  // Bumped by stop(): a connect() that was awaiting a URL when the socket was stopped must
  // not open a connection nobody will ever close.
  private epoch = 0;
  private backoff = BACKOFF_START_MS;
  private timer: NodeJS.Timeout | undefined;
  private seen = new Set<string>();
  private readonly Impl: SocketCtor;
  private readonly log: Pick<Logger, "log" | "warn">;

  constructor(
    private readonly openUrl: () => Promise<string>,
    private readonly onEvent: (event: unknown, eventId: string) => void,
    opts?: { WebSocketImpl?: SocketCtor; log?: Pick<Logger, "log" | "warn"> },
  ) {
    this.Impl = opts?.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
    this.log = opts?.log ?? new Logger(SlackSocket.name);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  // No reconnect follows. SlackService discards a stopped socket and builds a new one.
  stop(): void {
    this.started = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.drop();
  }

  // Listening means Slack said `hello`, not merely that TCP connected.
  isOpen(): boolean {
    return this.ready;
  }

  private async connect(): Promise<void> {
    const epoch = this.epoch;
    let url: string;
    try {
      url = await this.openUrl();
    } catch (err) {
      this.log.warn(`slack socket: apps.connections.open failed — ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    if (epoch !== this.epoch) return;
    const ws = new this.Impl(url);
    this.ws = ws;
    ws.onmessage = (ev) => this.frame(ws, ev.data);
    ws.onerror = (ev) => this.log.warn(`slack socket error: ${(ev as { message?: string })?.message ?? "unknown"}`);
    // Only the CURRENT connection's close means «reconnect»: a connection replaced after a
    // `disconnect` frame closes later and must not spawn a second replacement.
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.ready = false;
      this.scheduleReconnect();
    };
  }

  private frame(ws: SocketLike, data: unknown): void {
    let f: Frame;
    try {
      f = JSON.parse(typeof data === "string" ? data : String(data)) as Frame;
    } catch {
      return;
    }
    if (f.envelope_id) ws.send(JSON.stringify({ envelope_id: f.envelope_id }));

    if (f.type === "hello") {
      this.ready = true;
      this.backoff = BACKOFF_START_MS;
      return;
    }
    if (f.type === "disconnect") {
      this.log.log(`slack socket: disconnect requested (${f.reason ?? "no reason"}), reconnecting`);
      this.drop();
      void this.connect();
      return;
    }
    if (f.type !== "events_api" || !f.payload) return;
    const id = f.payload.event_id ?? f.envelope_id ?? "";
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > SEEN_EVENT_IDS) this.seen.delete(this.seen.values().next().value!);
    }
    try {
      this.onEvent(f.payload.event, id);
    } catch (err) {
      this.log.warn(`slack socket: event handler threw — ${(err as Error).message}`);
    }
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
    // A pending reconnect must not keep a shutting-down process alive.
    this.timer.unref?.();
  }
}
