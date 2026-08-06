// src/server/server.ts
import { homedir } from "os"; import { join } from "path"; import { mkdirSync } from "fs";
import type { ServerWebSocket } from "bun";
import { Registry } from "./registry"; import { Supervisor } from "./supervisor";

mkdirSync(join(homedir(), ".maestro"), { recursive: true });
const registry = new Registry(join(homedir(), ".maestro", "maestro.sqlite"));
const supervisor = new Supervisor(registry);
const sockets = new Set<ServerWebSocket<unknown>>();
supervisor.onServerEvent((e) => { const msg = JSON.stringify(e); for (const ws of sockets) ws.send(msg); });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const err = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, 400);

Bun.serve({
  port: 4317,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/ws") { if (server.upgrade(req)) return; return new Response("upgrade failed", { status: 400 }); }
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } });
    try {
      if (p === "/api/groups" && req.method === "GET") return json(registry.listGroups());
      if (p === "/api/groups" && req.method === "POST") { const b = await req.json(); return json(await supervisor.addGroup(b.name, b.projectDir)); }
      let m = p.match(/^\/api\/groups\/(.+)$/); if (m && req.method === "DELETE") { await supervisor.removeGroup(m[1]); return json({ ok: true }); }
      if (p === "/api/sessions" && req.method === "GET") return json(registry.listSessions(url.searchParams.get("groupId") ?? undefined));
      if (p === "/api/sessions" && req.method === "POST") { const b = await req.json(); return json(await supervisor.createSession(b.groupId, b.name, b.task, b.model)); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/message$/); if (m && req.method === "POST") { const b = await req.json(); supervisor.sendMessage(m[1], b.text, b.mode); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/answer$/); if (m && req.method === "POST") { const b = await req.json(); supervisor.answerUi(m[1], b.res); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/stop$/); if (m && req.method === "POST") { await supervisor.stopSession(m[1]); return json({ ok: true }); }
      m = p.match(/^\/api\/sessions\/([^/]+)\/transcript$/); if (m && req.method === "GET") return json(supervisor.getTranscript(m[1]));
      m = p.match(/^\/api\/sessions\/([^/]+)$/); if (m && req.method === "DELETE") { await supervisor.deleteSession(m[1]); return json({ ok: true }); }
      return new Response("not found", { status: 404 });
    } catch (e) { return err(e); }
  },
  websocket: {
    open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "snapshot", ...supervisor.snapshot() })); },
    close(ws) { sockets.delete(ws); },
    message() {},
  },
});
console.log("Maestro server on http://localhost:4317");
