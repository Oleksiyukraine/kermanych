// «Змінні» of the preview row (docs/specs/2026-11-04-session-env-and-tester-preview-gate.md,
// decision 2): GET/PUT /sessions/:id/env edit the `.env` the session's preview runs with — its
// worktree's, never the project's — and refuse the sessions that have no preview.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Subject } from "rxjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { PreviewService } from "../src/preview/preview.service";
import { EnvFileService } from "../src/env/env-file.service";
import { SessionsController } from "../src/http/sessions.controller";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { DeviceApi } from "../src/device/device.contract";

let root: string;
let repo: string;
let wt: string;
let ctl: SessionsController;
let registry: RegistryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kmq-session-env-"));
  repo = join(root, "repo");
  wt = join(root, "wt");
  mkdirSync(repo);
  mkdirSync(wt);
  writeFileSync(join(repo, ".env"), "API_URL=http://localhost:3000/api\n");
  writeFileSync(join(wt, ".env"), "# carried\nAPI_URL=http://localhost:3000/api\nTOKEN=s\n");
  registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: repo, platform: "web" });
  const preview = new PreviewService(registry, { exits$: new Subject() } as unknown as DeviceApi);
  const env = new EnvFileService({ isIgnored: async () => true } as unknown as WorktreeService);
  ctl = new SessionsController({} as never, registry, preview, env);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("session env", () => {
  it("reads and writes the worktree's .env and leaves the project's alone", async () => {
    const s = registry.createSession({ projectId: "p1", name: "x", task: "x", worktreePath: wt, branch: "b" });

    expect((await ctl.getEnv(s.id)).entries).toEqual([
      { key: "API_URL", value: "http://localhost:3000/api" },
      { key: "TOKEN", value: "s" },
    ]);
    const view = await ctl.putEnv(s.id, { set: { API_URL: "https://api.dev.example.com/api" }, remove: ["TOKEN"] });

    expect(view.entries).toEqual([{ key: "API_URL", value: "https://api.dev.example.com/api" }]);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("# carried\nAPI_URL=https://api.dev.example.com/api\n");
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("API_URL=http://localhost:3000/api\n");
  });

  it("an in-place session edits the project checkout's .env, the directory its preview runs in", async () => {
    const s = registry.createSession({ projectId: "p1", name: "x", task: "x", worktreePath: "", branch: "", worktree: false });
    await ctl.putEnv(s.id, { set: { API_URL: "https://api.dev.example.com/api" } });
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("API_URL=https://api.dev.example.com/api\n");
  });

  it("refuses a fork, a finished session and a back-end project", async () => {
    const doer = registry.createSession({ projectId: "p1", name: "x", task: "x", worktreePath: wt, branch: "b" });
    const fork = registry.createSession({ projectId: "p1", name: "f", task: "x", worktreePath: "", branch: "", worktree: false, kind: "review", parentSessionId: doer.id });
    await expect(ctl.getEnv(fork.id)).rejects.toThrow(/only agent sessions/);
    await expect(ctl.putEnv(fork.id, { set: { A: "1" } })).rejects.toThrow(/only agent sessions/);

    const finished = registry.createSession({ projectId: "p1", name: "y", task: "x", worktreePath: "", branch: "b" });
    await expect(ctl.getEnv(finished.id)).rejects.toThrow(/finished/);

    registry.upsertProject({ id: "p2", name: "be", localRepoPath: repo, platform: "backend" });
    const be = registry.createSession({ projectId: "p2", name: "z", task: "x", worktreePath: wt, branch: "b" });
    await expect(ctl.getEnv(be.id)).rejects.toThrow(/no live preview/);
    expect(readFileSync(join(wt, ".env"), "utf8")).toContain("TOKEN=s");
  });
});
