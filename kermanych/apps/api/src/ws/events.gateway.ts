// apps/api/src/ws/events.gateway.ts
import { OnModuleInit } from "@nestjs/common";
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { SupervisorService } from "../supervisor/supervisor.service";

@WebSocketGateway({ cors: { origin: "*" } })
export class EventsGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;

  constructor(private supervisor: SupervisorService) {}

  handleConnection(client: Socket) {
    client.emit("event", { type: "snapshot", ...this.supervisor.snapshot() });
  }

  onModuleInit() {
    this.supervisor.events$.subscribe((e) => this.server.emit("event", e));
  }
}
