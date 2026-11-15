// apps/api/src/ws/events.gateway.ts
import { OnModuleInit } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service";
import { SupervisorService } from "../supervisor/supervisor.service";

// The default namespace: a full supervisor snapshot on connect, then every session event.
//
// The handshake MUST carry the bearer the REST guard accepts (`auth: { token }`), as on
// `/terminal` and `/device`: this stream holds the state and transcripts of every session,
// and the api allows CORS `*` — without the check any page open in the operator's browser
// could read them. Only the token the ui handed to this api passes (AuthService.userForToken),
// and that handoff needs the app's own ui (auth/ui-proof.ts), so a page of another origin
// has nothing to present. A preview api (KERMANYCH_PREVIEW) admits everyone, as its REST
// guard does.
@WebSocketGateway({ cors: { origin: "*" }, maxHttpBufferSize: 64 * 1024 * 1024 })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;

  constructor(
    private supervisor: SupervisorService,
    private auth: AuthService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      if (process.env.KERMANYCH_PREVIEW === "1") return next();
      const token: unknown = socket.handshake.auth?.token;
      if (this.auth.userForToken(typeof token === "string" ? token : undefined)) return next();
      next(new Error("unauthorized"));
    });
  }

  handleConnection(client: Socket) {
    client.emit("event", { type: "snapshot", ...this.supervisor.snapshot() });
  }

  onModuleInit() {
    this.supervisor.events$.subscribe((e) => this.server.emit("event", e));
  }
}
