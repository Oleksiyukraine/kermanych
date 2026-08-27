// Resolves a project's skill library and lays it out on disk for one omp launch.
// The ONLY component that touches the filesystem or decides precedence:
//   repository skills  >  project_skills rows  >  Kermanych's DEFAULT_SKILLS
// The materialised directory doubles as the offline cache — there is no SQLite mirror.
import { Injectable } from "@nestjs/common";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
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

// "The path simply is not there" is the ordinary case — most repositories have none of the
// six skill directories. Every other errno (EACCES, EIO, ELOOP) is a real failure: treating
// it as "no repo skills" would fail the shadow guard OPEN and materialise a second skill
// under a name the repository already owns.
function isMissingPath(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissingPath(err)) return [];
    throw err;
  }
}

export async function repoSkillNames(cwd: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // An unbound project has no repository to scan; joining "" would silently resolve
  // against the api process's own working directory.
  if (!cwd) return found;
  for (const rel of REPO_SKILL_DIRS) {
    const base = join(cwd, rel);
    for (const e of await readEntries(base)) {
      // A vendored or shared skills folder is often linked in, and readdir does not follow
      // symlinks — an isDirectory()-only test would miss it and let a duplicate through.
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (found.has(e.name)) continue;
      const file = join(base, e.name, "SKILL.md");
      // Only a directory omp can actually discover a skill in may shadow the library.
      // An asset-only or leftover directory would otherwise suppress the library copy
      // while omp found nothing there either, and the skill would vanish from the session.
      // stat follows symlinks, which is what resolves the linked-in case above.
      try {
        if (!(await stat(file)).isFile()) continue;
      } catch (err) {
        if (isMissingPath(err)) continue;
        throw err;
      }
      found.set(e.name, file);
    }
  }
  return found;
}

// A projectId becomes a path segment under the skills root, which is then pruned with a
// recursive rm, and is interpolated into the config omp loads. Ids arrive from an HTTP body
// and are never generated locally, so `..` would escape the root and a newline would inject
// keys into the overlay. The skill-name pattern is the same boundary, and a lowercase UUID
// satisfies it. A caller error, so it throws: the launcher wraps the call and the session
// still starts, just without a library.
function assertProjectId(projectId: string): void {
  if (!isSkillName(projectId)) throw new Error(`invalid project id: ${projectId}`);
}

export type Materialized = { configPath?: string; view: SkillView[]; stale?: boolean };

@Injectable()
export class SkillsService {
  constructor(private auth: AuthService) {}

  // Seam for tests: the cloud read is the one part a unit test cannot perform.
  readRows = async (projectId: string): Promise<ProjectSkill[]> =>
    listProjectSkills(this.auth.cloudClient(), [projectId]);

  // Read-only: what the UI lists. Never writes, so a settings screen cannot mutate a
  // session's library as a side effect of being opened. Errors propagate on purpose: a
  // settings screen that showed the defaults after a failed read would tell the user their
  // project skills are gone, when what failed was the read.
  async view(projectId: string, cwd: string): Promise<SkillView[]> {
    assertProjectId(projectId);
    const rows = await this.readRows(projectId);
    const repo = await repoSkillNames(cwd);
    return resolveSkills(rows).map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));
  }

  // Never blocks a launch: every filesystem or cloud failure degrades to `stale: true` with
  // whatever is already on disk. `configPath` is absent when the overlay was not written —
  // passing omp a --config that does not exist would break the session outright.
  async materialize(projectId: string, cwd: string): Promise<Materialized> {
    assertProjectId(projectId);
    const dir = join(skillsRoot(), projectId);
    const overlay = join(skillsRoot(), `${projectId}.config.yml`);

    // Both reads happen before any write. `stale` means "the inputs are not trustworthy
    // enough to rewrite the library", and in that state the directory the last good launch
    // wrote IS the cache: nothing is rewritten and, above all, nothing is pruned.
    let repo = new Map<string, string>();
    let stale = false;
    try {
      repo = await repoSkillNames(cwd);
    } catch {
      // Without the shadow map, writing would risk a duplicate of a repository skill.
      stale = true;
    }
    let rows: ProjectSkill[] = [];
    try {
      rows = await this.readRows(projectId);
    } catch {
      stale = true; // offline or signed out
    }

    const resolved = resolveSkills(rows);
    const view: SkillView[] = resolved.map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));

    let configPath: string | undefined;
    try {
      await mkdir(dir, { recursive: true });
      // The overlay is a SIBLING of the scanned directory, never inside it.
      await writeFile(overlay, `skills:\n  customDirectories:\n    - ${dir}\n`, "utf8");
      configPath = overlay;
      if (!stale) {
        const keep = new Set<string>();
        for (const { def } of resolved) {
          if (repo.has(def.name)) continue; // the repository's own skill wins the name
          keep.add(def.name);
          await mkdir(join(dir, def.name), { recursive: true });
          await writeFile(join(dir, def.name, "SKILL.md"), renderSkillFile(def), "utf8");
        }
        // Runs only after every write succeeded, so a half-written library is never pruned
        // against. Removed AND newly repo-shadowed names both disappear here.
        for (const e of await readEntries(dir)) {
          if (e.isDirectory() && !keep.has(e.name)) await rm(join(dir, e.name), { recursive: true, force: true });
        }
      }
    } catch {
      // EACCES, ENOSPC, EROFS, or a plain file where the library should be.
      stale = true;
    }
    return { ...(configPath !== undefined ? { configPath } : {}), view, ...(stale ? { stale: true } : {}) };
  }
}
