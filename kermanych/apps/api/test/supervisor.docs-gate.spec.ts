// apps/api/test/supervisor.docs-gate.spec.ts
// «Обовʼязкова документація» end to end over a real git worktree: the gate reads the branch's
// actual change set, refuses PR / commit / finish while documentation is missing, lets them
// through once it is committed, «Доповнити документацію» asks for exactly the missing items
// with the resolved skill bodies, and the policy rides every spawn's system prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_DOCS_POLICY, DEFAULT_SKILLS, docsPolicyAppend, type DocsPolicy } from "@kermanych/core";
import type { AiSkill } from "@kermanych/cloud";

// Capture what the session's agent is spawned with and asked, as supervisor.pr.spec does.
const started: Record<string, unknown>[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: Record<string, unknown>) { started.push(opts); }
    onEvent() {}
    onExit() {}
    async start() {}
    async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    isAlive() { return true; }
    prompt(text: string) { prompts.push(text); }
    followUp(text: string) { prompts.push(text); }
    steer(text: string) { prompts.push(text); }
  }
  return { RpcSession: FakeRpc };
});

import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { SkillsService } from "../src/skills/skills.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

// A real uuid: the skill resolver refuses anything else as a project id.
const P = "44444444-4444-4444-8444-444444444444";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (dir: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const SPEC_NONE = "# Task\n\n## Documentation impact\n\nNone — internal refactor.\n";
const POLICY = docsPolicyAppend(DEFAULT_DOCS_POLICY);

const wt = new WorktreeService();
let repo: string;
let trash: string[];
let reg: RegistryService;
let sup: SupervisorService;
// The project's own skill rows, read by the REAL resolver (SkillsService.assignedForNames).
let library: AiSkill[];

beforeEach(() => {
  started.length = 0;
  prompts.length = 0;
  library = [];
  repo = mkdtempSync(join(tmpdir(), "kmq-docs-gate-"));
  trash = [repo];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  write(repo, "src/app.ts", "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  const skills = new SkillsService({ cloudClient: () => ({}) } as never);
  // Everything but the name resolver (which stubSkills leaves out) is stubbed like the other
  // supervisor specs.
  Object.assign(skills, stubSkills());
  skills.readSkills = async () => library;
  sup = new SupervisorService(reg, wt, offlineAuth(), skills);
});
afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// A project (switch on unless told otherwise, default rules unless given) and an agent session
// on a real worktree branched off `dev`; `work` runs inside the worktree before the row exists.
async function seed(work: (wtDir: string) => void, docsRequired = true, docsPolicy?: DocsPolicy): Promise<{ id: string; wtDir: string }> {
  reg.upsertProject({ id: P, name: "g", localRepoPath: repo, docsRequired, docsPolicy });
  const parent = mkdtempSync(join(tmpdir(), "kmq-docs-gate-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "kermanych/s1");
  work(wtDir);
  const s = reg.createSession({ projectId: P, name: "task", task: "t", worktreePath: wtDir, branch: "kermanych/s1", baseBranch: "dev" });
  reg.updateSession(s.id, { status: "done" });
  return { id: s.id, wtDir };
}

const codeOnly = (d: string) => write(d, "src/app.ts", "export const a = 2;\n");

describe("the documentation gate", () => {
  it("refuses PR, commit and finish while the task document is missing — before any side effect", async () => {
    const { id, wtDir } = await seed(codeOnly);

    for (const act of [() => sup.createPullRequest(id), () => sup.commitChanges(id), () => sup.finishSession(id)])
      await expect(act()).rejects.toThrow(/^documentation required: task-spec, docs-impact/);

    expect(prompts).toHaveLength(0); // the agent was never asked
    expect(existsSync(wtDir)).toBe(true); // finish retired nothing
    expect(git(wtDir, "status", "--porcelain")).toMatch(/src\/app\.ts/); // nor auto-committed
    expect((await sup.finishInfo(id)).docsGate).toEqual({ enabled: true, asks: ["handoff"], failures: ["task-spec", "docs-impact"] });
  });

  it("lets the PR through once the task document declares no documentation impact", async () => {
    const { id } = await seed((d) => {
      codeOnly(d);
      write(d, "docs/specs/2026-09-28-x.md", SPEC_NONE);
    });

    await sup.createPullRequest(id);

    expect(prompts.at(-1)).toMatch(/gh pr create/);
  });

  it("accepts a living-doc change instead of the declaration, and demands a requested handoff", async () => {
    const { id, wtDir } = await seed((d) => {
      codeOnly(d);
      write(d, "docs/specs/2026-09-28-x.md", "# Task\n\n## Documentation impact\n\nUpdated the flow.\n");
      write(d, "docs/schemas/flow.md", "# Flow\n");
    });

    expect((await sup.finishInfo(id)).docsGate.failures).toEqual([]);
    expect((await sup.finishInfo(id, { handoff: true })).docsGate.failures).toEqual(["handoff"]);
    await expect(sup.finishSession(id, { handoff: true })).rejects.toThrow(/^documentation required: handoff/);

    write(wtDir, "docs/handoffs/2026-09-28-x.md", "# Handoff\n\nNothing changed for the frontend.\n");
    expect(await sup.finishSession(id, { handoff: true })).toEqual({ finished: true, branch: "kermanych/s1" });
    // The documents were committed with the work onto the kept branch.
    expect(git(repo, "show", "kermanych/s1:docs/handoffs/2026-09-28-x.md")).toMatch(/Handoff/);
  });

  it("changes nothing with the project setting off", async () => {
    const { id } = await seed(codeOnly, false);

    expect((await sup.finishInfo(id, { handoff: true })).docsGate).toEqual({ enabled: false, asks: [], failures: [] });
    expect(await sup.completeDocs(id, { handoff: true })).toEqual({ sent: false, failures: [] });
    await sup.createPullRequest(id, { handoff: true });
    expect(prompts).toHaveLength(1);
    expect(started.at(-1)).not.toMatchObject({ appendSystemPrompt: expect.stringContaining(POLICY) });
    expect(await sup.finishSession(id)).toEqual({ finished: true, branch: "kermanych/s1" });
  });

  // Per-kind rules: a relaxed spec/schemas no longer block, a required plan does, and the API
  // request is a finish-sheet ask that only binds once ticked.
  it("applies the project's per-kind rules", async () => {
    const policy: DocsPolicy = { spec: "optional", plan: "required", schemas: "off", handoff: "off", apiRequest: "ask" };
    const { id, wtDir } = await seed(codeOnly, true, policy);

    expect((await sup.finishInfo(id)).docsGate).toEqual({ enabled: true, asks: ["apiRequest"], failures: ["plan"] });
    expect((await sup.finishInfo(id, { handoff: true, apiRequest: true })).docsGate.failures).toEqual(["plan", "api-request"]);

    write(wtDir, "docs/plans/2026-09-30-x.md", "# Plan\n");
    await expect(sup.createPullRequest(id, { apiRequest: true })).rejects.toThrow(/^documentation required: api-request/);
    await sup.createPullRequest(id);
    expect(prompts.at(-1)).toMatch(/gh pr create/);
  });
});

describe("completeDocs", () => {
  it("asks for exactly the missing items with the resolved skill bodies, a project override winning", async () => {
    library = [{ owner: { scope: "project", id: P }, id: "r1", name: "frontend-handoff", description: "d", body: "PROJECT HANDOFF RULES", enabled: true, updatedAt: "t" }];
    const { id } = await seed(codeOnly);

    const res = await sup.completeDocs(id, { handoff: true });

    expect(res).toEqual({ sent: true, failures: ["task-spec", "docs-impact", "handoff"] });
    const p = prompts.at(-1)!;
    expect(p).toMatch(/do not change code in this turn/);
    expect(p).toContain(DEFAULT_SKILLS.find((d) => d.name === "task-spec")!.body.trim());
    expect(p).toContain("PROJECT HANDOFF RULES");
    expect(p).not.toContain(DEFAULT_SKILLS.find((d) => d.name === "frontend-handoff")!.body.trim());
    // The spawn that carried the prompt runs under the documentation policy.
    expect(started.at(-1)).toMatchObject({ appendSystemPrompt: expect.stringContaining(POLICY) });
  });

  it("inlines the plan and API-request skills for their failures", async () => {
    const { id } = await seed(codeOnly, true, { ...DEFAULT_DOCS_POLICY, plan: "required", apiRequest: "ask" });

    expect(await sup.completeDocs(id, { apiRequest: true })).toEqual({ sent: true, failures: ["task-spec", "plan", "docs-impact", "api-request"] });
    const p = prompts.at(-1)!;
    for (const name of ["task-spec", "task-plan", "api-request"]) expect(p).toContain(DEFAULT_SKILLS.find((d) => d.name === name)!.body.trim());
    expect(p).not.toContain(DEFAULT_SKILLS.find((d) => d.name === "frontend-handoff")!.body.trim());
  });

  it("inlines no skill for a docs-impact-only gap, and sends nothing when nothing is missing", async () => {
    const { id, wtDir } = await seed((d) => {
      codeOnly(d);
      write(d, "docs/specs/2026-09-28-x.md", "# Task\n");
    });

    expect(await sup.completeDocs(id)).toEqual({ sent: true, failures: ["docs-impact"] });
    const p = prompts.at(-1)!;
    expect(p).toContain("docs/schemas/");
    expect(p).not.toContain("docs/handoffs/");
    expect(p).not.toContain("### task-spec");

    write(wtDir, "docs/specs/2026-09-28-x.md", SPEC_NONE);
    expect(await sup.completeDocs(id)).toEqual({ sent: false, failures: [] });
    expect(prompts).toHaveLength(1);
  });
});

describe("the documentation policy", () => {
  it("reaches the system prompt of a new chat only for a project with the switch on, built from its rules", async () => {
    reg.upsertProject({ id: P, name: "g", localRepoPath: repo, docsRequired: true });
    await sup.createChat(P);
    expect(started.at(-1)).toMatchObject({ appendSystemPrompt: expect.stringContaining(POLICY) });

    const apiFirst: DocsPolicy = { ...DEFAULT_DOCS_POLICY, handoff: "off", apiRequest: "optional" };
    await sup.updateProject(P, { docsPolicy: apiFirst });
    await sup.createChat(P);
    expect(started.at(-1)).toMatchObject({ appendSystemPrompt: expect.stringContaining(docsPolicyAppend(apiFirst)) });
    expect(started.at(-1)).not.toMatchObject({ appendSystemPrompt: expect.stringContaining("docs/handoffs/") });

    await sup.updateProject(P, { docsRequired: false });
    await sup.createChat(P);
    expect(started.at(-1)).not.toMatchObject({ appendSystemPrompt: expect.stringContaining("Documentation policy") });
  });
});
