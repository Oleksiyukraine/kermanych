import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Subject } from "rxjs";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { RegistryService } from "../src/registry/registry.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { EventsGateway } from "../src/ws/events.gateway";

// esbuild (vitest's transformer) emits no design:paramtypes, so declare the gateway's
// constructor deps by hand for Nest to inject the instances below.
Reflect.defineMetadata("design:paramtypes", [SupervisorService, AuthService], EventsGateway);

const TOKEN = "local-session-token";

describe("the events socket (default namespace)", () => {
  let app: INestApplication;
  let base: string;
  const events$ = new Subject<unknown>();
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const registry = new RegistryService(":memory:");
    registry.setAuthSession({ userId: "u-1", accessToken: TOKEN });
    const supervisor = { events$, snapshot: () => ({ sessions: [{ id: "s-1" }] }) };

    @Module({
      providers: [
        EventsGateway,
        { provide: SupervisorService, useValue: supervisor },
        { provide: AuthService, useValue: new AuthService(registry) },
      ],
    })
    class EventsModule {}

    app = await NestFactory.create(EventsModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const addr = app.getHttpServer().address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await app?.close();
  });

  function socket(token: string | undefined, transport: "websocket" | "polling" = "websocket"): Socket {
    const s = io(base, {
      auth: token === undefined ? {} : { token },
      transports: [transport],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(s);
    return s;
  }

  function nextEvent(s: Socket): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    s.once("event", resolve);
    s.once("connect_error", reject);
    return promise;
  }

  it("refuses a handshake without the local session's bearer, on either transport", async () => {
    for (const transport of ["websocket", "polling"] as const) {
      await expect(nextEvent(socket(undefined, transport))).rejects.toThrow("unauthorized");
      await expect(nextEvent(socket("someone-elses-token", transport))).rejects.toThrow("unauthorized");
    }
  });

  it("gives an authenticated socket the snapshot, then the live events", async () => {
    const s = socket(TOKEN);
    expect(await nextEvent(s)).toEqual({ type: "snapshot", sessions: [{ id: "s-1" }] });
    const live = nextEvent(s);
    events$.next({ type: "session_removed", sessionId: "s-1" });
    expect(await live).toEqual({ type: "session_removed", sessionId: "s-1" });
  });
});
