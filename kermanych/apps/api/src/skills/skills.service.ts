// Resolves a project's skill library and lays it out on disk for one omp launch.
// The ONLY component that touches the filesystem or decides precedence:
//   repository skills  >  project_skills rows  >  Kermanych's DEFAULT_SKILLS
// The materialised directory doubles as the offline cache — there is no SQLite mirror.
import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assignedBlock,
  DEFAULT_SKILLS,
  isSkillName,
  renderSkillFile,
  type SkillDef,
  type SkillView,
} from "@kermanych/core";
import { listAgentSkills, listProjectSkills, type AgentSkill, type ProjectSkill } from "@kermanych/cloud";
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

// `omp config get` answers in well under a second (it reads config files, no network), so
// this is a wedged process, not a slow one. It bounds a LAUNCH: nothing here may hang one.
const CONFIG_TIMEOUT_MS = 5_000;
// A list of directories is a few hundred bytes. Past this it is a broken omp streaming at
// us, and the truncated buffer simply fails to parse — which is handled.
const CONFIG_MAX_BYTES = 1 << 16;

// The EFFECTIVE `skills.customDirectories` for a session cwd, or `undefined` when it could
// not be read. Kermanych hands its overlay to omp as `--config`, the highest-precedence
// layer, and omp REPLACES array-typed settings wholesale instead of appending: an overlay
// naming only Kermanych's directory silently erases both the operator's own
// `~/.omp/agent/config.yml` entries and whatever the target repository declares in
// `<cwd>/.omp/config.yml` — the latter being exactly the "the repository always wins"
// constraint, one config layer up from the six directory conventions REPO_SKILL_DIRS guards.
// The read therefore runs IN the session cwd, so the project-level layer is part of the
// answer. Never rejects: an unreadable value means "do not write a replacing overlay".
function readOmpCustomDirectories(cwd: string): Promise<string[] | undefined> {
  const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
  let settled = false;
  const finish = (value: string[] | undefined): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  // An unbound project has no repo path; reading in the api's OWN cwd would pick up the
  // Kermanych checkout's project config, so fall back to the home layer instead.
  const child = spawn("omp", ["config", "get", "skills.customDirectories"], {
    cwd: cwd || homedir(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(undefined);
  }, CONFIG_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (b: Buffer) => {
    if (size >= CONFIG_MAX_BYTES) return;
    size += b.length;
    chunks.push(b);
  });
  // No omp on PATH, or a cwd that no longer exists.
  child.on("error", () => finish(undefined));
  child.on("close", (code) => {
    if (code !== 0) return finish(undefined);
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // A shape we do not understand is a value we cannot preserve, so it is a read failure
      // rather than something to overwrite.
      if (!Array.isArray(parsed) || parsed.some((d) => typeof d !== "string")) return finish(undefined);
      finish(parsed as string[]);
    } catch {
      finish(undefined);
    }
  });
  return promise;
}

// Kermanych's directory goes LAST: among custom directories the FIRST same-named skill wins,
// so appending preserves the precedence of every directory the operator and the repository
// already declared. Paths are quoted — `dir` derives from homedir(), which Kermanych does not
// control, and in a YAML plain scalar a ` #` opens a comment and a `: ` a mapping. A malformed
// overlay is a HARD omp startup error, the one outcome "never block a launch" forbids.
// JSON strings are valid YAML, the same technique renderSkillFile uses for descriptions.
function renderOverlay(dirs: readonly string[]): string {
  const lines = dirs.map((d) => `    - ${JSON.stringify(d)}`);
  return `skills:\n  customDirectories:\n${lines.join("\n")}\n`;
}

// Whether a name already has a materialised SKILL.md. Only ENOENT/ENOTDIR mean "no";
// any other errno is a real failure and belongs to the caller's degradation path.
async function hasSkillFile(dir: string, name: string): Promise<boolean> {
  try {
    await stat(join(dir, name, "SKILL.md"));
    return true;
  } catch (err) {
    if (isMissingPath(err)) return false;
    throw err;
  }
}

// A repository's own SKILL.md as a def, so an assigned name the repository owns is delivered
// with the REPOSITORY's text. The body is what the agent is given, so the frontmatter is
// stripped rather than parsed: a one-line `description:` is picked up for the UI's label
// (renderSkillFile writes exactly that, as a JSON string), and any richer YAML scalar simply
// leaves the label empty rather than pulling a YAML parser into the launch path.
// `undefined` on any read failure — the caller turns that into a `missing` entry, because a
// repository file that cannot be read must not crash a launch.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
async function readRepoSkill(path: string, name: string): Promise<SkillDef | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const m = FRONTMATTER_RE.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  let description = /^description:[ \t]*(.*)$/m.exec(m?.[1] ?? "")?.[1]?.trim() ?? "";
  if (description.startsWith('"')) {
    try {
      description = JSON.parse(description) as string;
    } catch {
      // Not a JSON string after all — the raw text is a better label than nothing.
    }
  }
  return { name, description, body };
}

// `stale` means "the library on disk may not reflect the cloud": a failed cloud read, a failed
// repo scan, an unreadable `skills.customDirectories`, or a filesystem failure. It is never a
// reason to refuse a launch. `configPath` is set only once the overlay write succeeded.
export type Materialized = { configPath?: string; view: SkillView[]; stale?: boolean };

@Injectable()
export class SkillsService {
  constructor(private auth: AuthService) {}

  // Seams for tests: the cloud read and the `omp` child are the two parts a unit test
  // cannot perform.
  readRows = async (projectId: string): Promise<ProjectSkill[]> =>
    listProjectSkills(this.auth.cloudClient(), [projectId]);
  readCustomDirs = (cwd: string): Promise<string[] | undefined> => readOmpCustomDirectories(cwd);
  readAssignments = async (projectId: string): Promise<AgentSkill[]> =>
    listAgentSkills(this.auth.cloudClient(), [projectId]);

  // What one agent's instruction carries for the skills assigned to it: the block to append,
  // the view the UI labels the rows with, and the names that resolved to nothing. Never
  // throws for a library reason — an agent that cannot read its assignments still runs with
  // its own instruction.
  async assignedFor(
    projectId: string,
    agentId: string,
    cwd: string,
  ): Promise<{ block: string; view: SkillView[]; missing: string[] }> {
    assertProjectId(projectId);
    let rows: AgentSkill[];
    try {
      rows = (await this.readAssignments(projectId)).filter((r) => r.agentId === agentId);
    } catch {
      return { block: "", view: [], missing: [] }; // offline or signed out
    }
    // The operator's own order, with the name as the tiebreak so two rows that were never
    // reordered still read the same way on every launch.
    rows.sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
    return this.assignedForNames(
      projectId,
      rows.map((r) => r.skillName),
      cwd,
    );
  }

  // The resolution half, given names in the order they must appear. Shared with the trigger
  // path, which materialises the same bodies from a different source: precedence has exactly
  // one answer, and it lives here. Degrades rather than throws for the same reason as above.
  async assignedForNames(
    projectId: string,
    names: readonly string[],
    cwd: string,
  ): Promise<{ block: string; view: SkillView[]; missing: string[] }> {
    assertProjectId(projectId);
    // A failed CLOUD read only narrows the library to DEFAULT_SKILLS, which need neither
    // network nor sign-in, so an assigned default is still delivered. A failed REPO SCAN is
    // different: with no trustworthy shadow map, delivering the library's text could hand the
    // agent a body the repository has overridden, and "the repository always wins" outranks
    // delivering anything at all. Same degradation as an unreachable cloud, one layer up.
    const [library, repo] = await Promise.all([
      this.readRows(projectId).catch(() => [] as ProjectSkill[]),
      repoSkillNames(cwd).catch(() => undefined),
    ]);
    if (!repo) return { block: "", view: [], missing: [] };
    const resolved = new Map(resolveSkills(library).map((r) => [r.def.name, r]));
    const defs: SkillDef[] = [];
    const view: SkillView[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue; // a name delivered twice would just spend context twice
      seen.add(name);
      const hit = resolved.get(name);
      const repoPath = repo.get(name);
      if (!hit && !repoPath) {
        missing.push(name);
        continue;
      }
      // The repository's own file wins the name, so its text is what the agent must be given.
      const def = repoPath ? await readRepoSkill(repoPath, name) : hit!.def;
      if (!def) {
        missing.push(name);
        continue;
      }
      defs.push(def);
      view.push({
        name: def.name,
        description: def.description,
        source: hit?.source ?? "project",
        ...(repoPath ? { shadowedByRepo: repoPath } : {}),
      });
    }
    return { block: assignedBlock(defs), view, missing };
  }

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

  // Never blocks a launch: every filesystem, cloud or config failure degrades to
  // `stale: true` with whatever is already on disk. `configPath` is absent when the overlay
  // was not written — passing omp a --config that does not exist would break the session.
  async materialize(projectId: string, cwd: string): Promise<Materialized> {
    assertProjectId(projectId);
    const dir = join(skillsRoot(), projectId);
    const overlay = join(skillsRoot(), `${projectId}.config.yml`);

    // Both reads happen before any write, and the two degradations are tracked apart because
    // they forbid different things. A failed REPO SCAN leaves no trustworthy shadow map, so
    // writing could duplicate a name the repository already owns: nothing is written. A failed
    // CLOUD READ only narrows the resolved set to DEFAULT_SKILLS, which are compile-time
    // constants needing neither network nor sign-in — those must still land, or a fresh,
    // offline or signed-out machine launches against an empty directory. Neither may prune:
    // in both states the directory the last good launch wrote IS the cache.
    let repo = new Map<string, string>();
    let repoFailed = false;
    let cloudFailed = false;
    try {
      repo = await repoSkillNames(cwd);
    } catch {
      repoFailed = true;
    }
    let rows: ProjectSkill[] = [];
    try {
      rows = await this.readRows(projectId);
    } catch {
      cloudFailed = true; // offline or signed out
    }
    let stale = repoFailed || cloudFailed;

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
      const inherited = await this.readCustomDirs(cwd);
      if (inherited === undefined) {
        // An overlay written blind would REPLACE the operator's and the repository's own
        // directories. Losing the library for this launch is strictly better than erasing
        // them, and a missing config path is already a tolerated state.
        stale = true;
      } else {
        // The overlay is a SIBLING of the scanned directory, never inside it. A prior entry for
        // Kermanych's own directory is dropped rather than kept in place, so the appended copy
        // is the only one and our directory can never outrank a directory someone else declared.
        const dirs = [...new Set(inherited.filter((d) => d !== dir)), dir];
        await writeFile(overlay, renderOverlay(dirs), "utf8");
        configPath = overlay;
      }
      if (!repoFailed) {
        const keep = new Set<string>();
        for (const { def } of resolved) {
          if (repo.has(def.name)) continue; // the repository's own skill wins the name
          keep.add(def.name);
          // With no cloud, `resolved` is just the defaults: rewriting a name already on disk
          // would demote a project's own skill to the default that shares its name.
          if (cloudFailed && (await hasSkillFile(dir, def.name))) continue;
          await mkdir(join(dir, def.name), { recursive: true });
          await writeFile(join(dir, def.name, "SKILL.md"), renderSkillFile(def), "utf8");
        }
        // Runs only after every write succeeded, so a half-written library is never pruned
        // against. Removed AND newly repo-shadowed names both disappear here. Skipped when the
        // cloud failed: `resolved` is then not the real library, and pruning against it would
        // delete every cached project skill.
        if (!cloudFailed) {
          for (const e of await readEntries(dir)) {
            if (e.isDirectory() && !keep.has(e.name)) await rm(join(dir, e.name), { recursive: true, force: true });
          }
        }
      }
    } catch {
      // EACCES, ENOSPC, EROFS, or a plain file where the library should be.
      stale = true;
    }
    return { ...(configPath !== undefined ? { configPath } : {}), view, ...(stale ? { stale: true } : {}) };
  }
}
