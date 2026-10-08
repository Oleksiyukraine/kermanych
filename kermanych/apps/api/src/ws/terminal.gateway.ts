// apps/api/src/ws/terminal.gateway.ts
import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import type { Subscription } from "rxjs";
import type { TerminalAttachReply, TerminalError, TerminalInfo, TerminalOpenReply } from "@kermanych/core";
import { AuthService } from "../auth/auth.service";
import { TerminalRefusal, TerminalService } from "../terminal/terminal.service";

// The integrated terminal's transport: the `/terminal` socket.io namespace.
//
//   client → server (ack):  list · open {projectId, cols, rows} · attach {id}
//   client → server:        detach {id} · input {id, data} · resize {id, cols, rows} · kill {id}
//   server → client:        data {id, data}   — only to sockets attached to that terminal
//                           opened TerminalInfo · exit {id, exitCode}   — to every socket
//
// The handshake MUST carry the bearer the REST guard accepts (`auth: { token }`). The
// default namespace only broadcasts, but a socket here writes to a shell, and the api
// allows CORS `*` — without this check any page open in the operator's browser could run
// commands on the machine. A preview api (KERMANYCH_PREVIEW) admits everyone, as its
// REST guard does.
@WebSocketGateway({ namespace: "terminal", cors: { origin: "*" } })
export class TerminalGateway implements OnGatewayInit, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Namespace;
  private sub: Subscription | undefined;

  constructor(
    private terminals: TerminalService,
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

  onModuleInit(): void {
    this.sub = this.terminals.events$.subscribe((e) => {
      if (e.type === "data") this.server.to(e.id).emit("data", { id: e.id, data: e.data });
      else if (e.type === "opened") this.server.emit("opened", e.terminal);
      else this.server.emit("exit", { id: e.id, exitCode: e.exitCode });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  @SubscribeMessage("list")
  list(): TerminalInfo[] {
    return this.terminals.list();
  }

  // Opening does not attach: the client attaches right after, the same way it re-attaches
  // after a reload, so there is one path that joins the room and sends the replay.
  @SubscribeMessage("open")
  open(@MessageBody() body: { projectId?: unknown; cols?: unknown; rows?: unknown }): TerminalOpenReply {
    if (typeof body?.projectId !== "string") return refusal(new TerminalRefusal("project_not_found", "projectId missing"));
    try {
      return { terminal: this.terminals.open(body.projectId, Number(body.cols), Number(body.rows)) };
    } catch (err) {
      return refusal(err);
    }
  }

  @SubscribeMessage("attach")
  async attach(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }): Promise<TerminalAttachReply> {
    const id = body?.id;
    if (typeof id !== "string") return refusal(new TerminalRefusal("terminal_not_found", "id missing"));
    try {
      const snapshot = this.terminals.attach(id);
      // The same tick as the snapshot point: what the pty prints from here on is streamed,
      // everything before is in the replay. (The in-memory adapter joins synchronously.)
      // Streamed chunks can reach the client ahead of this reply; the ui holds them until
      // the replay is painted (apps/ui/src/stores/terminal.ts).
      void client.join(id);
      return await snapshot;
    } catch (err) {
      return refusal(err);
    }
  }

  @SubscribeMessage("detach")
  async detach(@ConnectedSocket() client: Socket, @MessageBody() body: { id?: unknown }): Promise<void> {
    if (typeof body?.id === "string") await client.leave(body.id);
  }

  @SubscribeMessage("input")
  input(@MessageBody() body: { id?: unknown; data?: unknown }): void {
    if (typeof body?.id === "string" && typeof body.data === "string") this.terminals.write(body.id, body.data);
  }

  @SubscribeMessage("resize")
  resize(@MessageBody() body: { id?: unknown; cols?: unknown; rows?: unknown }): void {
    if (typeof body?.id === "string") this.terminals.resize(body.id, Number(body.cols), Number(body.rows));
  }

  @SubscribeMessage("kill")
  kill(@MessageBody() body: { id?: unknown }): void {
    if (typeof body?.id === "string") this.terminals.kill(body.id);
  }
}

function refusal(err: unknown): TerminalError {
  if (err instanceof TerminalRefusal) return { error: err.code, message: err.message };
  return { error: "spawn_failed", message: err instanceof Error ? err.message : String(err) };
}
