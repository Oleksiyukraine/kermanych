// kermanych/apps/api/test/skills.e2e.spec.ts
// Env-gated, like packages/cloud's RLS suite: needs a working `omp` on PATH.
// KERMANYCH_E2E_OMP=1 pnpm --filter @kermanych/api exec vitest run test/skills.e2e.spec.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSkill, ProjectTrigger } from "@kermanych/cloud";
import type { RpcEvent } from "@kermanych/core";
import { RpcSession } from "../src/rpc/rpc-session";
import { SkillsService, triggersRoot } from "../src/skills/skills.service";

const gated = process.env.KERMANYCH_E2E_OMP === "1";

describe.skipIf(!gated)("skill library reaches a real omp child", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "kmq-e2e-repo-"));
    home = mkdtempSync(join(tmpdir(), "kmq-e2e-home-"));
    process.env.KERMANYCH_SKILLS_HOME = home;
  });
  afterEach(() => {
    delete process.env.KERMANYCH_SKILLS_HOME;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const row = (name: string, description: string): ProjectSkill => ({
    projectId: "p1", name, description, body: "body", enabled: true, updatedAt: "t",
  });

  async function systemPrompt(configPath: string, cwd: string): Promise<string> {
    const rpc = new RpcSession({ cwd, configPath });
    rpc.onExit(() => {});
    await rpc.start();
    try {
      const state = (await rpc.getState()) as { systemPrompt?: string[] };
      return (state.systemPrompt ?? []).join("\n");
    } finally {
      await rpc.stop();
    }
  }

  test("library skills appear in the system prompt", async () => {
    const svc = new SkillsService({ cloudClient: () => ({}) } as never);
    svc.readRows = async () => [row("probe-alpha", "PROBE ALPHA from the library")];
    const { configPath } = await svc.materialize("p1", repo);
    // `configPath` is optional: absent means the overlay was never written, which is a
    // failure of this test's premise rather than something to hand omp as undefined.
    if (!configPath) throw new Error("materialize wrote no overlay");
    const sp = await systemPrompt(configPath, repo);
    expect(sp).toContain("probe-alpha");
    expect(sp).toContain("PROBE ALPHA from the library");
  }, 120_000);

  test("a repository skill of the same name wins", async () => {
    mkdirSync(join(repo, ".claude/skills/probe-alpha"), { recursive: true });
    writeFileSync(
      join(repo, ".claude/skills/probe-alpha/SKILL.md"),
      "---\nname: probe-alpha\ndescription: PROBE ALPHA from the repository\n---\nrepo body\n",
    );
    const svc = new SkillsService({ cloudClient: () => ({}) } as never);
    // probe-gamma is the control: it is NOT shadowed, so it can only reach the prompt through
    // the overlay. Without it, both assertions below would hold even with --config removed —
    // omp discovers `.claude/skills` natively from cwd — and the case would pin Task 5's
    // shadow suppression instead of this task's launch wiring.
    svc.readRows = async () => [
      row("probe-alpha", "PROBE ALPHA from the library"),
      row("probe-gamma", "PROBE GAMMA from the library"),
    ];
    const { configPath } = await svc.materialize("p1", repo);
    // `configPath` is optional: absent means the overlay was never written, which is a
    // failure of this test's premise rather than something to hand omp as undefined.
    if (!configPath) throw new Error("materialize wrote no overlay");
    const sp = await systemPrompt(configPath, repo);
    expect(sp).toContain("PROBE ALPHA from the repository");
    expect(sp).not.toContain("PROBE ALPHA from the library");
    expect(sp).toContain("PROBE GAMMA from the library");
  }, 120_000);

  test("a skills directory a LOWER config layer declares survives the overlay", async () => {
    // omp REPLACES array-typed settings from a higher layer wholesale, and `--config` is the
    // highest layer there is. So an overlay naming only Kermanych's directory would erase this
    // one — the target repository's own declaration — silently. The project-level
    // `<cwd>/.omp/config.yml` is the cheapest lower layer to stand one up in.
    const theirs = mkdtempSync(join(tmpdir(), "kmq-e2e-theirs-"));
    try {
      mkdirSync(join(theirs, "probe-delta"), { recursive: true });
      writeFileSync(
        join(theirs, "probe-delta/SKILL.md"),
        "---\nname: probe-delta\ndescription: PROBE DELTA from the repository's own directory\n---\ntheir body\n",
      );
      mkdirSync(join(repo, ".omp"), { recursive: true });
      writeFileSync(
        join(repo, ".omp/config.yml"),
        `skills:\n  customDirectories:\n    - ${JSON.stringify(theirs)}\n`,
      );

      const svc = new SkillsService({ cloudClient: () => ({}) } as never);
      svc.readRows = async () => [row("probe-epsilon", "PROBE EPSILON from the library")];
      const { configPath } = await svc.materialize("p1", repo);
      if (!configPath) throw new Error("materialize wrote no overlay");
      const sp = await systemPrompt(configPath, repo);
      expect(sp).toContain("PROBE DELTA from the repository's own directory");
      expect(sp).toContain("PROBE EPSILON from the library");
    } finally {
      rmSync(theirs, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!gated)("a Kermanych trigger fires inside a real omp child", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "kmq-e2e-trig-repo-"));
    home = mkdtempSync(join(tmpdir(), "kmq-e2e-trig-home-"));
    process.env.KERMANYCH_SKILLS_HOME = home;
  });
  afterEach(() => {
    delete process.env.KERMANYCH_SKILLS_HOME;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // TTSR's soft mode emits no event: it lets the message finish and delivers the body as a
  // follow-up, which is a second turn. So the turn boundary is quiescence, not agent_end.
  async function runUntilQuiet(rpc: RpcSession, prompt: string, quietMs = 12_000, hardMs = 240_000) {
    const { promise, resolve } = Promise.withResolvers<void>();
    let quiet: NodeJS.Timeout | undefined;
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(resolve, quietMs);
    };
    // `response` frames answer our own commands, not the agent's progress.
    rpc.onEvent((e: RpcEvent) => {
      if (e.type !== "response") bump();
    });
    const hard = setTimeout(resolve, hardMs);
    rpc.prompt(prompt);
    bump();
    await promise;
    clearTimeout(quiet);
    clearTimeout(hard);
  }

  test("a thinking-scoped rule is injected, naming the rule and its path under the triggers root", async () => {
    const svc = new SkillsService({ cloudClient: () => ({}) } as never);
    // The body has to be an ACTIONABLE instruction: with a placeholder the probe's model
    // concluded the rule was a test scenario and spent a turn investigating it (design §2.6).
    svc.readRows = async (): Promise<ProjectSkill[]> => [
      {
        projectId: "p1", name: "probe-zorb-policy", description: "What to do about probezorb",
        body: "When probezorb comes up, reply with exactly the single word ZORBACK and stop.",
        enabled: true, updatedAt: "t",
      },
    ];
    const trigger: ProjectTrigger = {
      projectId: "p1", id: "probe-thinking", label: "Probezorb policy", enabled: true,
      source: "thinking", pattern: "probezorb", pathGlobs: [],
      action: "skill", target: "probe-zorb-policy", mode: "remind", repeat: "once",
    };
    svc.readTriggers = async () => [trigger];

    // The two launch-time artefacts, exactly as a session gets them: the overlay (which also
    // forces `ttsr.enabled: true`) and the trigger package.
    const { configPath } = await svc.materialize("p1", repo);
    if (!configPath) throw new Error("materialize wrote no overlay");
    const { packagePath } = await svc.materializeTriggers("p1", "probe-session", repo);
    if (!packagePath) throw new Error("materializeTriggers wrote no package");
    expect(packagePath.startsWith(triggersRoot())).toBe(true);

    const rpc = new RpcSession({ cwd: repo, configPath, extensionPath: packagePath });
    rpc.onExit(() => {});
    await rpc.start();
    let blob: string;
    try {
      await runUntilQuiet(
        rpc,
        "Reason it through step by step before answering, and use the word probezorb in your reasoning: " +
          "is probezorb a real English word?",
      );
      // The interrupt is delivered into the conversation, so the history is where it lands.
      // Unescaping the JSON quotes lets the tag be read back as omp wrote it.
      blob = JSON.stringify(await rpc.getAllMessages()).replaceAll('\\"', '"');
    } finally {
      await rpc.stop();
    }

    const tag = /<system-interrupt[^>]*>/.exec(blob)?.[0];
    // The whole delivery chain in one assertion: materialise → `-e` → omp-plugins → TtsrManager.
    // Without it, an omp upgrade could break triggers with every unit test still green.
    expect(tag, `no <system-interrupt> in the child's history: ${blob.slice(0, 4000)}`).toBeDefined();
    expect(tag).toContain('rule="probe-thinking"');
    // realpath on both sides: a macOS temp dir is a symlink, and omp reports the resolved path.
    const path = /path="([^"]+)"/.exec(tag!)?.[1] ?? "";
    expect(realpathSync(path)).toBe(realpathSync(join(packagePath, "rules", "probe-thinking.md")));
  }, 300_000);
});
