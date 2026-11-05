import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { SkillImportController } from "../src/http/skill-import.controller";
import { FsController } from "../src/http/fs.controller";
import { parseSkillFile, scanSkillFolder } from "../src/skills/skill-files";

let root: string;
let prevHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kmq-skill-import-"));
  prevHome = process.env.HOME;
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, text: string, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

const ctl = new SkillImportController();

test("frontmatter: a block-scalar description is collapsed, the body is everything after it", () => {
  const parsed = parseSkillFile("---\nname: humanizer\ndescription: |\n  Rewrite text.\n  Keep meaning.\n---\n\n# Body\nline\n");
  expect(parsed).toEqual({ name: "humanizer", description: "Rewrite text. Keep meaning.", body: "# Body\nline\n" });
});

test("frontmatter that is not YAML is flagged, and the body survives", () => {
  const parsed = parseSkillFile("---\nname: [unclosed\ndescription: x\n---\nBody\n");
  expect(parsed.frontmatterError).toBe(true);
  expect(parsed.description).toBe("");
  expect(parsed.body).toBe("Body\n");
});

test("the home roots list only existing roots and only folders holding a SKILL.md", async () => {
  process.env.HOME = root;
  skill(join(root, ".agents/skills/humanizer"), "---\nname: humanizer\ndescription: d\n---\nB\n", {
    "scripts/check.py": "x",
    "README.md": "r",
    ".git/HEAD": "ref",
  });
  // an asset-only folder and Claude.ai's bookkeeping are not skills
  mkdirSync(join(root, ".agents/skills/assets-only/img"), { recursive: true });
  skill(join(root, ".agents/skills/.staging/hidden"), "---\nname: hidden\ndescription: d\n---\n");
  // a linked-in skill folder counts
  skill(join(root, "shared/linked"), "---\ndescription: from a link\n---\nL\n");
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  symlinkSync(join(root, "shared/linked"), join(root, ".claude/skills/linked"), "dir");

  const roots = await ctl.roots();
  expect(roots.map((r) => r.label)).toEqual(["~/.claude/skills", "~/.agents/skills"]);
  const agents = roots.find((r) => r.label === "~/.agents/skills")!;
  expect(agents.skills.map((s) => s.name)).toEqual(["humanizer"]);
  // the body is not part of a listing; the other files are, relative and without .git
  expect(agents.skills[0]).not.toHaveProperty("body");
  expect(agents.skills[0]).toMatchObject({ extraFiles: ["README.md", "scripts/check.py"], extraCount: 2 });
  // no frontmatter name: the folder name stands in
  expect(roots[0]!.skills[0]).toMatchObject({ name: "linked", description: "from a link" });
});

test("a name that is not a legal library name gets a suggestion", async () => {
  skill(join(root, "Dev_Report"), "---\ndescription: d\n---\n");
  const { skills } = await scanSkillFolder(join(root, "Dev_Report"));
  expect(skills[0]).toMatchObject({ name: "Dev_Report", suggestedName: "dev-report" });
});

test("a chosen folder is one skill, a root of several, or none", async () => {
  skill(join(root, "one"), "---\nname: one\ndescription: d\n---\n");
  skill(join(root, "pack/a"), "---\nname: a\ndescription: d\n---\n");
  skill(join(root, "pack/b"), "---\nname: b\ndescription: d\n---\n");
  mkdirSync(join(root, "empty"));

  expect((await ctl.scan(join(root, "one"))).skills.map((s) => s.name)).toEqual(["one"]);
  expect((await ctl.scan(join(root, "pack"))).skills.map((s) => s.name)).toEqual(["a", "b"]);
  expect((await ctl.scan(join(root, "empty"))).skills).toEqual([]);
  await expect(ctl.scan(join(root, "missing"))).rejects.toBeInstanceOf(BadRequestException);
});

test("read returns the body, and refuses a folder without SKILL.md", async () => {
  skill(join(root, "one"), "---\nname: one\ndescription: d\n---\nThe body.\n", { "ref.md": "r" });
  const read = await ctl.read(join(root, "one"));
  expect(read).toMatchObject({ name: "one", description: "d", body: "The body.\n", extraFiles: ["ref.md"] });
  mkdirSync(join(root, "plain"));
  await expect(ctl.read(join(root, "plain"))).rejects.toBeInstanceOf(BadRequestException);
});

test("the skills-mode folder listing shows hidden folders and marks skill folders", async () => {
  mkdirSync(join(root, ".agents"));
  mkdirSync(join(root, "visible"));
  skill(join(root, "a-skill"), "---\ndescription: d\n---\n");
  const fs = new FsController();
  const plain = await fs.list(root);
  expect(plain.entries.map((e) => e.name)).toEqual(["a-skill", "visible"]);
  expect(plain.entries[0]).not.toHaveProperty("hasSkill");
  const hidden = await fs.list(root, "1");
  expect(hidden.entries.map((e) => [e.name, e.hasSkill])).toEqual([
    [".agents", false],
    ["a-skill", true],
    ["visible", false],
  ]);
});
