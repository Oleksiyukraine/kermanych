// apps/api/test/preview.spec.ts
import { afterEach, expect, test } from "vitest";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { PreviewService } from "../src/preview/preview.service";
import type { RegistryService } from "../src/registry/registry.service";

// A one-liner http server that binds $PORT and echoes `body` — stands in for a real
// dev server so we exercise port allocation, spawn, readiness and teardown.
const httpEcho = (body: string): string =>
  `node -e "require('http').createServer((_,r)=>r.end(${body})).listen(process.env.PORT)"`;

// Minimal registry seam: one session with a temp worktree, one group with the given
// commands. Cast is a test double for the DI boundary, never read through inline.
function fakeReg(previewCommand?: string, apiCommand?: string): RegistryService {
  const stub = {
    listSessions: () => [{ id: "s1", groupId: "g1", worktreePath: "/tmp" }],
    listGroups: () => [{ id: "g1", previewCommand, apiCommand }],
  };
  return stub as unknown as RegistryService;
}

function canConnect(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const sock = connect(port, "127.0.0.1");
  sock.once("connect", () => {
    sock.destroy();
    resolve(true);
  });
  sock.once("error", () => {
    sock.destroy();
    resolve(false);
  });
  return promise;
}

let svc: PreviewService;
afterEach(() => svc?.onModuleDestroy());

test("starts a listening web server on a free port; stop kills the process tree", async () => {
  svc = new PreviewService(fakeReg(httpEcho("'ok'")));
  const res = await svc.start("s1");
  if (!("url" in res)) throw new Error("expected a preview url");
  const port = Number(new URL(res.url).port);
  expect(await canConnect(port)).toBe(true);
  svc.stop("s1");
  await sleep(700);
  expect(await canConnect(port)).toBe(false);
}, 30_000);

test("full-stack: web command receives VITE_API_BASE pointing at the branch api port", async () => {
  svc = new PreviewService(fakeReg(httpEcho("process.env.VITE_API_BASE"), httpEcho("'api'")));
  const res = await svc.start("s1");
  if (!("url" in res)) throw new Error("expected a preview url");
  const body = await fetch(res.url).then((r) => r.text());
  expect(body).toMatch(/^http:\/\/localhost:\d+\/api$/); // web was wired to the api
  const apiPort = Number(new URL(body).port);
  expect(await canConnect(apiPort)).toBe(true); // the branch api is actually up
  expect(apiPort).not.toBe(Number(new URL(res.url).port)); // two distinct free ports
}, 30_000);

test("returns needsCommand when the group has no preview command", async () => {
  svc = new PreviewService(fakeReg(undefined));
  expect(await svc.start("s1")).toEqual({ needsCommand: true });
});
