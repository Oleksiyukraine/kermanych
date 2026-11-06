// apps/api/test/skill-improvement.spec.ts
// «Самовдосконалення скілів» (docs/specs/2026-11-04-skill-self-improvement.md): what
// `improve_skill` writes to the operator's personal layer and records, every refusal the agent
// can get, who is handed the tool at which level, and who gets the reflection step
// (docs/specs/2026-11-06-skill-improvement-reflection.md). Real registry, fake cloud calls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpAdapterHost } from "@nestjs/core";
import {
  DEFAULT_SKILLS,
  skillLessonRule,
  skillReflectionBlock,
  type Session,
  type SkillImprovementInsert,
  type SkillImprovementLevel,
} from "@kermanych/core";
import type { AiOwner, AiSkill, AiSkillInsert } from "@kermanych/cloud";
import { RegistryService } from "../src/registry/registry.service";
import type { SkillsService } from "../src/skills/skills.service";
import type { AuthService } from "../src/auth/auth.service";
import type { PreviewService } from "../src/preview/preview.service";
import { SkillImprovementService, type SkillImprovementCloud } from "../src/skills/skill-improvement.service";
import { BrowserMcpService } from "../src/browser/browser-mcp.service";
import { setBrowserHost } from "../src/browser/browser-host";
import { fakeDevice } from "./fake-device";

const BODY = "# Deploy\n\nRun the build.\nThen ship it.\n";
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function row(owner: AiOwner, name: string, body = BODY, description = `${name} desc`): AiSkill {
  return { id: `${owner.scope}-${name}`, owner, name, description, body, enabled: true, createdAt: "", updatedAt: "" };
}

const U: AiOwner = { scope: "user", id: "u1" };
const P: AiOwner = { scope: "project", id: "p1" };
const W: AiOwner = { scope: "workspace", id: "w1" };

function make(opts: { rows?: AiSkill[]; kind?: Session["kind"]; native?: boolean; worktreePath?: string; signedIn?: boolean; count?: number } = {}) {
  const registry = new RegistryService(":memory:");
  registry.upsertProject({ id: "p1", name: "p", localRepoPath: "", workspaceId: "w1" });
  const s = registry.createSession({
    projectId: "p1", name: "Session one", task: "t", worktreePath: opts.worktreePath ?? "", branch: "b",
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.native ? { native: true } : {}),
  });
  if (opts.signedIn !== false) registry.setAuthSession({ userId: "u1", accessToken: "t" });
  // The cloud's user rows, mutated by the fake upsert/delete so the re-read sees writes.
  const store = new Map<string, AiSkill>((opts.rows ?? []).filter((r) => r.owner.scope === "user").map((r) => [r.name, r]));
  const rows = opts.rows ?? [];
  const skills = { readSkills: vi.fn(async () => rows), forgetLibrary: vi.fn() } as unknown as SkillsService;
  const auth = {
    current: () => (opts.signedIn === false ? undefined : { userId: "u1" }),
    cloudClient: () => ({}),
  } as unknown as AuthService;
  const records: SkillImprovementInsert[] = [];
  const cloud = {
    getAiSkill: vi.fn(async (_c: unknown, _o: AiOwner, name: string) => store.get(name)),
    upsertAiSkill: vi.fn(async (_c: unknown, i: AiSkillInsert) => {
      const r = row(i.owner, i.name, i.body, i.description);
      store.set(i.name, r);
      return r;
    }),
    deleteAiSkill: vi.fn(async (_c: unknown, _o: AiOwner, name: string) => {
      store.delete(name);
    }),
    insertSkillImprovement: vi.fn(async (_c: unknown, r: SkillImprovementInsert) => {
      records.push(r);
      return "rec-1";
    }),
    countSessionSkillImprovements: vi.fn(async () => opts.count ?? 0),
  };
  const service = new SkillImprovementService(registry, skills, auth, cloud as unknown as SkillImprovementCloud);
  const improve = (args: Record<string, unknown>) => service.improve(s.id, args);
  return { registry, session: s, store, records, cloud, improve };
}

const edit = (skill: string, find = "Run the build.", replace = "Run the build with --frozen-lockfile.") => ({
  skill,
  edits: [{ find, replace }],
  summary: "pin the lockfile",
  reason: "the build pulled a new version",
});

describe("improve_skill", () => {
  it("copies a project skill into the personal layer and records its team origin", async () => {
    const t = make({ rows: [row(P, "deploy"), row(W, "deploy", "workspace text")] });
    const r = await t.improve(edit("deploy"));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("(change rec-1)");
    expect(t.store.get("deploy")).toMatchObject({ owner: U, body: BODY.replace("Run the build.", "Run the build with --frozen-lockfile."), description: "deploy desc", enabled: true });
    expect(t.records).toEqual([
      expect.objectContaining({
        userId: "u1", skillName: "deploy", teamScope: "project", teamOwnerId: "p1", createdCopy: true, beforeBody: BODY,
        sessionName: "Session one", projectId: "p1", workspaceId: "w1", summary: "pin the lockfile",
      }),
    ]);
  });

  it("names a workspace origin and a default origin", async () => {
    const w = make({ rows: [row(W, "deploy")] });
    expect((await w.improve(edit("deploy"))).ok).toBe(true);
    expect(w.records[0]).toMatchObject({ teamScope: "workspace", teamOwnerId: "w1" });

    const def = DEFAULT_SKILLS[0]!;
    const find = def.body.split("\n").find((l) => l.trim() !== "" && def.body.split(l).length === 2)!;
    const d = make();
    const r = await d.improve(edit(def.name, find, `${find} (amended)`));
    expect(r.ok).toBe(true);
    expect(d.records[0]).toMatchObject({ teamScope: "default", createdCopy: true, beforeBody: def.body });
    expect(d.records[0]!.teamOwnerId).toBeUndefined();
  });

  it("edits an existing personal copy: not a new copy, its body is the base", async () => {
    const mine = "# Deploy\n\nRun the build.\nMy own note.\n";
    const t = make({ rows: [row(P, "deploy"), row(U, "deploy", mine)] });
    expect((await t.improve(edit("deploy"))).ok).toBe(true);
    expect(t.records[0]).toMatchObject({ createdCopy: false, beforeBody: mine, teamScope: "project" });
    expect(t.store.get("deploy")!.body).toBe(mine.replace("Run the build.", "Run the build with --frozen-lockfile."));
  });

  it("a personal-only skill has no team origin", async () => {
    const t = make({ rows: [row(U, "mine")] });
    expect((await t.improve(edit("mine"))).ok).toBe(true);
    expect(t.records[0]).toMatchObject({ teamScope: "none", createdCopy: false });
  });

  it("refuses a repository skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "improve-"));
    temps.push(dir);
    mkdirSync(join(dir, ".claude/skills/deploy"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: d\n---\nx\n");
    const t = make({ rows: [row(P, "deploy")], worktreePath: dir });
    const r = await t.improve(edit("deploy"));
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toMatch(/^Not applied: "deploy" is a repository skill \(.+\); it outranks the library/);
    expect(t.cloud.upsertAiSkill).not.toHaveBeenCalled();
  });

  it("refuses an unknown skill and invalid arguments", async () => {
    const t = make({ rows: [row(P, "deploy")] });
    expect((await t.improve(edit("nope"))).text).toBe(
      'Not applied: "nope" is not a skill of the Kermanych library. Skills from home folders or harness plugins are not Kermanych\'s to change.',
    );
    const bad = await t.improve({ skill: "deploy", edits: [], summary: "s", reason: "r" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/^Not applied: .+\.$/);
  });

  it("refuses a missing or ambiguous fragment with the current text", async () => {
    const t = make({ rows: [row(P, "deploy")] });
    const missing = await t.improve(edit("deploy", "Run the tests."));
    expect(missing.text).toBe(
      `Not applied: edit 1's \`find\` does not occur in the skill's current text. Copy it verbatim from the text below and try again.\n\n--- current text of deploy ---\n${BODY}`,
    );
    const ambiguous = await t.improve(edit("deploy", "\n"));
    expect(ambiguous.text).toMatch(/^Not applied: edit 1's `find` occurs more than once/);
    expect(ambiguous.text).toContain(`--- current text of deploy ---\n${BODY}`);
    expect(t.cloud.upsertAiSkill).not.toHaveBeenCalled();
  });

  it("refuses an over-size result", async () => {
    const t = make({ rows: [row(P, "deploy")] });
    const r = await t.improve(edit("deploy", "Run the build.", "x".repeat(70_000)));
    expect(r.text).toMatch(/^Not applied: the result would be \d+ bytes; a skill may be at most 64000\.$/);
  });

  it("refuses past the per-session cap", async () => {
    const t = make({ rows: [row(P, "deploy")], count: 5 });
    expect((await t.improve(edit("deploy"))).text).toBe(
      "Not applied: this session already made 5 skill improvements, the most one session may. Mention further lessons in your reply.",
    );
  });

  it("refuses at level off, signed out, or outside a managed agent/chat session", async () => {
    const off = make({ rows: [row(P, "deploy")] });
    off.registry.setAuthSession({ userId: "u1", accessToken: "t", skillImprovementLevel: "off" });
    expect((await off.improve(edit("deploy"))).text).toBe(
      "Not applied: the operator has turned skill improvement off. Mention the lesson in your reply instead.",
    );
    expect((await make({ rows: [row(P, "deploy")], signedIn: false }).improve(edit("deploy"))).text).toMatch(/not signed in to the cloud/);
    expect((await make({ native: true }).improve(edit("deploy"))).text).toBe("improve_skill is not available in this session.");
    expect((await make({ kind: "review" }).improve(edit("deploy"))).text).toBe("improve_skill is not available in this session.");
    expect((await make({ kind: "chat", rows: [row(P, "deploy")] }).improve(edit("deploy"))).ok).toBe(true);
  });

  it("reverts the personal row when the record cannot be written", async () => {
    const created = make({ rows: [row(P, "deploy")] });
    created.cloud.insertSkillImprovement.mockRejectedValueOnce(new Error("rls"));
    const r = await created.improve(edit("deploy"));
    expect(r.text).toBe("Not applied: the change could not be recorded (rls); the skill was left as it was.");
    expect(created.store.has("deploy")).toBe(false);

    const mine = "# Deploy\n\nRun the build.\nMine.\n";
    const existing = make({ rows: [row(U, "deploy", mine)] });
    existing.cloud.insertSkillImprovement.mockRejectedValueOnce(new Error("rls"));
    await existing.improve(edit("deploy"));
    expect(existing.store.get("deploy")!.body).toBe(mine);
  });

  it("re-bases on a personal copy that changed between read and write", async () => {
    const t = make({ rows: [row(P, "deploy")] });
    const moved = "# Deploy\n\nRun the build.\nWritten elsewhere meanwhile.\n";
    t.store.set("deploy", row(U, "deploy", moved));
    expect((await t.improve(edit("deploy"))).ok).toBe(true);
    expect(t.records[0]).toMatchObject({ createdCopy: false, beforeBody: moved });
    expect(t.store.get("deploy")!.body).toBe(moved.replace("Run the build.", "Run the build with --frozen-lockfile."));

    const gone = make({ rows: [row(P, "deploy"), row(U, "deploy", "# Deploy\n\nRun the build.\nOld copy.\n")] });
    gone.store.delete("deploy");
    expect((await gone.improve(edit("deploy"))).ok).toBe(true);
    expect(gone.records[0]).toMatchObject({ createdCopy: true, beforeBody: BODY });

    const stale = make({ rows: [row(P, "deploy")] });
    stale.store.set("deploy", row(U, "deploy", "# Deploy\n\nRewritten.\n"));
    const r = await stale.improve(edit("deploy"));
    expect(r.text).toContain("--- current text of deploy ---\n# Deploy\n\nRewritten.\n");
    expect(stale.cloud.upsertAiSkill).not.toHaveBeenCalled();
  });
});

describe("improve_skill in tools/list", () => {
  const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
  setBrowserHost(undefined);

  function setup(opts: { kind?: Session["kind"]; native?: boolean; level?: SkillImprovementLevel; tester?: boolean }) {
    const registry = new RegistryService(":memory:");
    registry.upsertProject({ id: "p1", name: "p", localRepoPath: "" });
    const s = registry.createSession({
      projectId: "p1", name: "n", task: "t", worktreePath: "", branch: "b",
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.native ? { native: true } : {}),
      ...(opts.tester ? { tester: true } : {}),
    });
    registry.setAuthSession({ userId: "u1", accessToken: "t", ...(opts.level ? { skillImprovementLevel: opts.level } : {}) });
    const improvements = {} as SkillImprovementService;
    const mcp = new BrowserMcpService(registry, {} as PreviewService, fakeDevice().device, http, undefined, improvements);
    const list = async () => {
      const reply = (await mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
        result: { tools: { name: string; description: string }[] };
      };
      return reply.result.tools.find((t) => t.name === "improve_skill");
    };
    return { registry, mcp, session: s, list };
  }
  const listed = async (opts: Parameters<typeof setup>[0]) => !!(await setup(opts).list());

  it("is listed for a managed agent or chat session only, and not at level off", async () => {
    expect(await listed({})).toBe(true);
    expect(await listed({ kind: "chat" })).toBe(true);
    expect(await listed({ native: true })).toBe(false);
    expect(await listed({ kind: "review" })).toBe(false);
    expect(await listed({ kind: "review", tester: true })).toBe(false);
    expect(await listed({ level: "off" })).toBe(false);
  });

  it("describes when to call it at the operator's level, with no word that most sessions improve nothing", async () => {
    for (const level of ["conservative", "moderate", "active"] as const) {
      const tool = await setup({ level }).list();
      expect(tool!.description).toContain(skillLessonRule(level));
      expect(tool!.description).not.toMatch(/Most sessions improve nothing/);
    }
    expect((await setup({}).list())!.description).toContain(skillLessonRule("moderate"));
  });
});

describe("the reflection step", () => {
  const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;

  function setup(opts: { kind?: Session["kind"]; native?: boolean } = {}) {
    const registry = new RegistryService(":memory:");
    registry.upsertProject({ id: "p1", name: "p", localRepoPath: "" });
    const s = registry.createSession({
      projectId: "p1", name: "n", task: "t", worktreePath: "", branch: "b",
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.native ? { native: true } : {}),
    });
    registry.setAuthSession({ userId: "u1", accessToken: "t" });
    const mcp = new BrowserMcpService(registry, {} as PreviewService, fakeDevice().device, http, undefined, {} as SkillImprovementService);
    const list = () => mcp.handle(s.id, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const level = (l: SkillImprovementLevel) => registry.setAuthSession({ userId: "u1", accessToken: "t", skillImprovementLevel: l });
    return { mcp, id: s.id, list, level };
  }

  it("follows the level at send time, also before the session's agent listed its tools", async () => {
    const t = setup();
    // A dormant session: its PR prompt is built before the respawn that lists the tools.
    expect(t.mcp.skillReflection(t.id)).toBe(`\n\n${skillReflectionBlock("moderate")}`);
    await t.list();
    t.level("active");
    expect(t.mcp.skillReflection(t.id)).toBe(`\n\n${skillReflectionBlock("active")}`);
    t.level("off");
    expect(t.mcp.skillReflection(t.id)).toBe("");
  });

  it("is withheld while the session's agent runs with a tool list that had no improve_skill", async () => {
    const launchedOff = setup();
    launchedOff.level("off");
    await launchedOff.list();
    launchedOff.level("moderate");
    expect(launchedOff.mcp.skillReflection(launchedOff.id)).toBe("");
    // Its relaunch lists the tool, and the step comes back.
    await launchedOff.list();
    expect(launchedOff.mcp.skillReflection(launchedOff.id)).toBe(`\n\n${skillReflectionBlock("moderate")}`);

    const native = setup({ native: true });
    expect(native.mcp.skillReflection(native.id)).toBe("");
    const chat = setup({ kind: "chat" });
    expect(chat.mcp.skillReflection(chat.id)).toBe(`\n\n${skillReflectionBlock("moderate")}`);
  });
});
