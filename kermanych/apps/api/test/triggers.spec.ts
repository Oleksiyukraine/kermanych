// kermanych/apps/api/test/triggers.spec.ts
// Triggers have two halves and this file covers both of the ones a unit test can reach:
// the TTSR rule file Kermanych renders, and the per-session package it lays out for `-e`.
// The delivery chain itself (package → omp-plugins → TtsrManager) is skills.e2e.spec.ts.
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSkill, ProjectTrigger } from "@kermanych/cloud";
import { renderRuleFile, SkillsService, triggersRoot } from "../src/skills/skills.service";

const t = (over: Partial<ProjectTrigger>): ProjectTrigger => ({
  projectId: "p1", id: "env-guard", label: "Нова env-змінна", enabled: true,
  source: "thinking", pattern: "new env var", pathGlobs: [],
  action: "skill", target: "how-we-add-env", mode: "remind", repeat: "once", ...over,
});

test("a thinking trigger becomes a rule scoped to thinking, soft by default", () => {
  const out = renderRuleFile(t({}), "Body.");
  expect(out).toContain('condition: "new env var"');
  expect(out).toContain("scope: [thinking]");
  expect(out).toContain("interruptMode: never");
  expect(out).toContain("repeatMode: once");
  expect(out.trimEnd().endsWith("Body.")).toBe(true);
});

test("assistant and tool sources map to their own scopes, and globs ride along", () => {
  expect(renderRuleFile(t({ source: "assistant" }), "B")).toContain("scope: [text]");
  const tool = renderRuleFile(t({ source: "tool", pathGlobs: [".github/workflows/*.yml"] }), "B");
  expect(tool).toContain("scope: [tool]");
  expect(tool).toContain('globs: [".github/workflows/*.yml"]');
});

test("the hard mode is opt-in and maps to always", () => {
  expect(renderRuleFile(t({ mode: "interrupt", repeat: "after-gap" }), "B")).toContain("interruptMode: always");
  expect(renderRuleFile(t({ mode: "interrupt", repeat: "after-gap" }), "B")).toContain("repeatMode: after-gap");
});

test("a pattern with YAML-hostile characters survives", () => {
  const out = renderRuleFile(t({ pattern: "env: #prod" }), "B");
  expect(out).toContain('condition: "env: #prod"');
});

test("an operator trigger has no rule file at all", () => {
  // Rendering one would put a rule in the child that can never match: Kermanych, not TTSR,
  // is what sees the operator's text. A caller error, so it throws rather than degrading.
  expect(() => renderRuleFile(t({ source: "operator" }), "B")).toThrow(/operator-sourced/);
});

test("a source outside the union is refused rather than written as `scope: undefined`", () => {
  // `scope` is the one frontmatter value not JSON-encoded, so it is the one that can be
  // malformed. omp rejects a bad rule at LOAD — after the write already succeeded — which is
  // the one path where a trigger could still block a launch.
  const stale = { ...t({}), source: "reasoning" } as unknown as ProjectTrigger;
  expect(() => renderRuleFile(stale, "B")).toThrow(/unknown source: reasoning/);
});

// The same refusal, for the one out-of-union value that the lookup itself used to hand back a
// truthy answer for: `TRIGGER_SCOPE` is a plain object, so `TRIGGER_SCOPE.constructor` is
// inherited from Object.prototype and walked straight past the `if (!scope)` guard, writing a
// stringified function into the YAML. A guard that exists for values outside the union must not
// be defeatable by one of them.
test("a source that names an Object.prototype member is refused like any other unknown", () => {
  const stale = { ...t({}), source: "constructor" } as unknown as ProjectTrigger;
  expect(() => renderRuleFile(stale, "B")).toThrow(/unknown source: constructor/);
  // And the three real sources still resolve — the guard did not become a blanket refusal.
  expect(renderRuleFile(t({ source: "thinking" }), "B")).toContain("scope: [thinking]");
  expect(renderRuleFile(t({ source: "assistant" }), "B")).toContain("scope: [text]");
  expect(renderRuleFile(t({ source: "tool" }), "B")).toContain("scope: [tool]");
});

// ---- materializeTriggers -------------------------------------------------------------

const row = (p: Partial<ProjectSkill> & { name: string }): ProjectSkill => ({
  projectId: "p1", description: "d", body: "b", enabled: true, updatedAt: "t", ...p,
});

// Same shape as skills.materialize.spec.ts: the auth stub stands in for the cloud, and each
// test replaces the two seams the read goes through.
const service = (triggers: ProjectTrigger[], skills: ProjectSkill[] = [row({ name: "how-we-add-env", body: "ADD ENV" })]) => {
  const svc = new SkillsService({ cloudClient: () => ({}) } as never);
  svc.readCustomDirs = async () => [];
  svc.readRows = async () => skills;
  svc.readTriggers = async () => triggers;
  return svc;
};

let repo: string;
let home: string;
const SID = "s-1";
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-trig-repo-"));
  home = mkdtempSync(join(tmpdir(), "kmq-trig-home-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});
afterEach(() => {
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("the package is a loadable extension: package.json, an entry point, and one rule per trigger", async () => {
  const svc = service([t({})]);
  const { packagePath } = await svc.materializeTriggers("p1", SID, repo);
  expect(packagePath).toBe(join(triggersRoot(), SID));
  // `-e` only discovers a sibling `rules/` for a package whose entry point actually resolves,
  // which is why the no-op index.js is not optional (design §2.6).
  const pkg = JSON.parse(readFileSync(join(packagePath!, "package.json"), "utf8")) as {
    omp?: { extensions?: string[] };
  };
  expect(pkg.omp?.extensions?.length).toBeGreaterThan(0);
  expect(existsSync(join(packagePath!, pkg.omp!.extensions![0]!.replace(/^\.\//, "")))).toBe(true);
  const rule = readFileSync(join(packagePath!, "rules", "env-guard.md"), "utf8");
  expect(rule).toContain("scope: [thinking]");
  // The body is the resolved skill's text, through the ONE resolver — not the skill's name.
  expect(rule).toContain("ADD ENV");
});

test("an operator-sourced trigger writes no rule file", async () => {
  const svc = service([t({ id: "wants-pr", source: "operator", action: "agent", target: "pull-request" })]);
  const { packagePath } = await svc.materializeTriggers("p1", SID, repo);
  expect(packagePath).toBeUndefined();
  expect(existsSync(join(triggersRoot(), SID, "rules", "wants-pr.md"))).toBe(false);
});

test("a stale row whose source TTSR has no scope for costs its own rule, not the package", async () => {
  const stale = { ...t({ id: "stale" }), source: "reasoning" } as unknown as ProjectTrigger;
  const { packagePath } = await service([stale, t({})]).materializeTriggers("p1", SID, repo);
  expect(readdirSync(join(packagePath!, "rules"))).toEqual(["env-guard.md"]);
  // Never `scope: undefined`, which omp rejects at load — the one malformed-rule path a
  // write-time try/catch cannot see.
  expect(readFileSync(join(packagePath!, "rules", "env-guard.md"), "utf8")).not.toContain("undefined");
});

test("a disabled trigger writes no rule file", async () => {
  const svc = service([t({ enabled: false })]);
  expect(await svc.materializeTriggers("p1", SID, repo)).toEqual({});
});

test("a trigger whose target resolves to nothing writes no rule file", async () => {
  // A dangling name is reported by the UI, not silently turned into an empty rule: a rule with
  // no body would fire and tell the model nothing.
  const svc = service([t({ target: "no-such-skill" })], []);
  expect(await svc.materializeTriggers("p1", SID, repo)).toEqual({});
});

test("a repository skill of the same name supplies the rule body", async () => {
  mkdirSync(join(repo, ".claude/skills/how-we-add-env"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/how-we-add-env/SKILL.md"), "---\nname: how-we-add-env\n---\nREPO ENV\n");
  const svc = service([t({})]);
  const { packagePath } = await svc.materializeTriggers("p1", SID, repo);
  const rule = readFileSync(join(packagePath!, "rules", "env-guard.md"), "utf8");
  expect(rule).toContain("REPO ENV");
  expect(rule).not.toContain("ADD ENV");
});

test("a rule whose trigger is gone is pruned on the next launch", async () => {
  const both = service([t({}), t({ id: "second", label: "Друге" })]);
  await both.materializeTriggers("p1", SID, repo);
  expect(readdirSync(join(triggersRoot(), SID, "rules")).sort()).toEqual(["env-guard.md", "second.md"]);
  await service([t({})]).materializeTriggers("p1", SID, repo);
  expect(readdirSync(join(triggersRoot(), SID, "rules"))).toEqual(["env-guard.md"]);
});

test("the whole package is removed once the last trigger goes", async () => {
  await service([t({})]).materializeTriggers("p1", SID, repo);
  expect(existsSync(join(triggersRoot(), SID))).toBe(true);
  expect(await service([]).materializeTriggers("p1", SID, repo)).toEqual({});
  // A left-behind package would keep firing rules the operator has already deleted.
  expect(existsSync(join(triggersRoot(), SID))).toBe(false);
});

test("a failed cloud read costs the session its triggers, never its launch", async () => {
  const svc = service([]);
  svc.readTriggers = async () => {
    throw new Error("offline");
  };
  await expect(svc.materializeTriggers("p1", SID, repo)).resolves.toEqual({});
});

test("ids that would escape the triggers root are refused", async () => {
  const svc = service([t({})]);
  for (const bad of ["../evil", "S1", "", "a b"]) {
    await expect(svc.materializeTriggers("p1", bad, repo)).rejects.toThrow(/invalid session id/);
    await expect(svc.materializeTriggers(bad, SID, repo)).rejects.toThrow(/invalid project id/);
  }
});

test("operatorTriggers returns only the enabled operator rows, in a stable order", async () => {
  const svc = service([
    t({ id: "zeta", source: "operator", action: "agent", target: "review" }),
    t({ id: "alpha", source: "operator" }),
    t({ id: "off", source: "operator", enabled: false }),
    t({ id: "thinker" }),
  ]);
  expect((await svc.operatorTriggers("p1")).map((x) => x.id)).toEqual(["alpha", "zeta"]);
});

test("operatorTriggers degrades to none when the cloud read fails", async () => {
  const svc = service([]);
  svc.readTriggers = async () => {
    throw new Error("offline");
  };
  await expect(svc.operatorTriggers("p1")).resolves.toEqual([]);
});
