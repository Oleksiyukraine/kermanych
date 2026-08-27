// Resolves a project's skill library and lays it out on disk for one omp launch.
// The ONLY component that touches the filesystem or decides precedence:
//   repository skills  >  project_skills rows  >  Kermanych's DEFAULT_SKILLS
// The materialised directory doubles as the offline cache — there is no SQLite mirror.
import { Injectable } from "@nestjs/common";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SKILLS, isSkillName, renderSkillFile, type SkillDef, type SkillView } from "@kermanych/core";
import { listProjectSkills, type ProjectSkill } from "@kermanych/cloud";
import { AuthService } from "../auth/auth.service";

// Every project-level skill directory omp itself discovers in the session cwd. One level
// deep, no ancestor walk: a Kermanych session's cwd is always a repository root (a worktree
// root or the bound repo). A library skill whose name appears here is NOT materialised.
export const REPO_SKILL_DIRS = [
  ".omp/skills",
  ".claude/skills",
  ".agent/skills",
  ".agents/skills",
  ".codex/skills",
  ".github/skills",
] as const;

// KERMANYCH_SKILLS_HOME exists for tests, mirroring KERMANYCH_DB in the registry.
export function skillsRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "skills");
}

export type Resolved = { def: SkillDef; source: "default" | "project" };

export function resolveSkills(rows: readonly ProjectSkill[]): Resolved[] {
  const out = new Map<string, Resolved>();
  for (const d of DEFAULT_SKILLS) out.set(d.name, { def: d, source: "default" });
  for (const r of rows) {
    // A disabled row is how a project turns a default off; on a name with no default it is
    // simply nothing to add.
    if (!r.enabled) {
      out.delete(r.name);
      continue;
    }
    out.set(r.name, { def: { name: r.name, description: r.description, body: r.body }, source: "project" });
  }
  // Last line of defence before mkdir/write: the DB has the same constraints, but a bad row
  // from an older client must never become a directory name or a description-less skill.
  return [...out.values()].filter((s) => isSkillName(s.def.name) && s.def.description.trim() !== "");
}

export async function repoSkillNames(cwd: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!cwd) return found;
  for (const rel of REPO_SKILL_DIRS) {
    const base = join(cwd, rel);
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !found.has(e.name)) found.set(e.name, join(base, e.name, "SKILL.md"));
    }
  }
  return found;
}

@Injectable()
export class SkillsService {
  constructor(private auth: AuthService) {}

  // Seam for tests: the cloud read is the one part a unit test cannot perform.
  readRows = async (projectId: string): Promise<ProjectSkill[]> =>
    listProjectSkills(this.auth.cloudClient(), [projectId]);

  // Read-only: what the UI lists. Never writes, so a settings screen cannot mutate a
  // session's library as a side effect of being opened.
  async view(projectId: string, cwd: string): Promise<SkillView[]> {
    const rows = await this.readRows(projectId).catch(() => [] as ProjectSkill[]);
    const repo = await repoSkillNames(cwd);
    return resolveSkills(rows).map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));
  }

  async materialize(projectId: string, cwd: string): Promise<{ configPath: string; view: SkillView[] }> {
    const dir = join(skillsRoot(), projectId);
    const configPath = join(skillsRoot(), `${projectId}.config.yml`);
    const repo = await repoSkillNames(cwd);
    let rows: ProjectSkill[] | undefined;
    try {
      rows = await this.readRows(projectId);
    } catch {
      // Offline or signed out: the directory the last online launch wrote IS the cache, so
      // the session keeps the library it had. Nothing is rewritten and nothing is pruned.
      rows = undefined;
    }
    const resolved = resolveSkills(rows ?? []);
    const view: SkillView[] = resolved.map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));

    await mkdir(dir, { recursive: true });
    // The overlay is a SIBLING of the scanned directory, never inside it.
    await writeFile(configPath, `skills:\n  customDirectories:\n    - ${dir}\n`, "utf8");
    if (rows === undefined) return { configPath, view };

    const keep = new Set<string>();
    for (const { def } of resolved) {
      if (repo.has(def.name)) continue; // the repository's own skill wins the name
      keep.add(def.name);
      await mkdir(join(dir, def.name), { recursive: true });
      await writeFile(join(dir, def.name, "SKILL.md"), renderSkillFile(def), "utf8");
    }
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !keep.has(e.name)) await rm(join(dir, e.name), { recursive: true, force: true });
    }
    return { configPath, view };
  }
}
