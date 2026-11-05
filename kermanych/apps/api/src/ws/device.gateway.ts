// apps/api/src/ws/device.gateway.ts
// The operator's device screen (docs/specs/2026-11-03-mobile-device-preview.md, decision 12): the
// `/device` socket.io namespace, so the web build streams and drives the device the same way the
// desktop app does. The protocol is in `@kermanych/core`'s device.ts:
//
//   client → server (ack):  watch {sessionId, width, height} → DeviceWatchReply
//   client → server:        unwatch {sessionId} · input {sessionId, input: DeviceInput}
//   server → client:        frame DeviceFrame — only to sockets watching that session
//
// The handshake MUST carry the bearer the REST guard accepts, exactly as `/terminal`: a socket
// here taps and types on a device signed in to the operator's accounts, and the api allows CORS
// `*`. A preview api (KERMANYCH_PREVIEW) admits everyone, as its REST guard does.
import { Inject } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import { DEVICE_BUTTONS, type DeviceButton, type DeviceInput, type DeviceWatchReply } from "@kermanych/core";
import { AuthService } from "../auth/auth.service";
import { DEVICE_API, type DeviceApi } from "../device/device.contract";

@WebSocketGateway({ namespace: "device", cors: { origin: "*" } })
export class DeviceGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer() server!: Namespace;
  // socket id → session id → the socket's watch. Each socket has its own, carrying its pane size;
  // DeviceService runs one upstream per device at the largest of them.
  private watches = new Map<string, Map<string, () => void>>();

  constructor(
    @Inject(DEVICE_API) private device: DeviceApi,
    private auth: AuthService,
  ) {}

  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      if (process.env.KERMANYCH_PREVIEW === "1") return next();
      const token: unknown = socket.handshake.auth?.token;
      if (this.auth.userForToken(typeof token === "string" ? token : undefined)) return next();
      next(new Error("unauthorized"));
    });
  }

  handleDisconnect(client: Socket): void {
    for (const stop of this.watches.get(client.id)?.values() ?? []) stop();
    this.watches.delete(client.id);
  }

  // A repeated watch of the same session replaces the socket's size. Frames are volatile: a
  // socket that cannot keep up skips frames instead of queueing them (an Android frame is
  // width×height×3 bytes).
  @SubscribeMessage("watch")
  watch(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId?: unknown; width?: unknown; height?: unknown }): DeviceWatchReply {
    const sessionId = body?.sessionId;
    if (typeof sessionId !== "string") return { ok: false, error: "sessionId missing" };
    const runtime = this.device.runtime(sessionId);
    if (!runtime) return { ok: false, error: "no device is running for this session" };
    const size = { width: Number(body.width) || runtime.screen.width, height: Number(body.height) || runtime.screen.height };
    let mine = this.watches.get(client.id);
    if (!mine) this.watches.set(client.id, (mine = new Map()));
    mine.get(sessionId)?.();
    mine.set(
      sessionId,
      this.device.watch(sessionId, size, (f) => client.volatile.emit("frame", f)),
    );
    return { ok: true, runtime };
  }

  @SubscribeMessage("unwatch")
  unwatch(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId?: unknown }): void {
    const sessionId = body?.sessionId;
    if (typeof sessionId !== "string") return;
    const mine = this.watches.get(client.id);
    mine?.get(sessionId)?.();
    mine?.delete(sessionId);
  }

  @SubscribeMessage("input")
  input(@MessageBody() body: { sessionId?: unknown; input?: unknown }): void {
    const sessionId = body?.sessionId;
    const input = deviceInput(body?.input);
    if (typeof sessionId !== "string" || !input) return;
    this.device.input(sessionId, input).catch((err: unknown) => console.warn(`[device] input ${input.type} for ${sessionId} failed: ${(err as Error).message}`));
  }
}

const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isButton = (v: unknown): v is DeviceButton => (DEVICE_BUTTONS as readonly unknown[]).includes(v);

// The socket's input is checked before it reaches a device: it comes from any authenticated
// client, and a NaN coordinate would reach the simulator's HID layer as is.
function deviceInput(v: unknown): DeviceInput | null {
  if (!v || typeof v !== "object" || !("type" in v)) return null;
  const i = v as Record<string, unknown>;
  switch (i.type) {
    case "touch":
      return (i.phase === "begin" || i.phase === "move" || i.phase === "end") && fraction(i.x) && fraction(i.y) ? { type: "touch", phase: i.phase, x: i.x, y: i.y } : null;
    case "scroll":
      return fraction(i.x) && fraction(i.y) && finite(i.dx) && finite(i.dy) ? { type: "scroll", x: i.x, y: i.y, dx: i.dx, dy: i.dy } : null;
    case "text":
      return typeof i.text === "string" && i.text ? { type: "text", text: i.text } : null;
    case "key":
      return typeof i.key === "string" ? { type: "key", key: i.key } : null;
    case "button":
      return isButton(i.button) ? { type: "button", button: i.button } : null;
    case "rotate":
      return i.orientation === "portrait" || i.orientation === "landscape" ? { type: "rotate", orientation: i.orientation } : null;
    default:
      return null;
  }
}
