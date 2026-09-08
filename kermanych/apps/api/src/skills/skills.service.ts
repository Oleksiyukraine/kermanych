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
  agentById,
  assignedBlock,
  DEFAULT_SKILLS,
  instructionErrors,
  isSkillName,
  renderSkillFile,
  type ProjectSkillsPayload,
  type SkillDef,
  type SkillView,
} from "@kermanych/core";
import {
  listAiAgentSkills,
  listAiAgents,
  listAiSkills,
  listAiTriggers,
  type AiAgent,
  type AiAgentSkill,
  type AiOwner,
  type AiScope,
  type AiSkill,
  type AiTrigger,
  type SupabaseClient,
} from "@kermanych/cloud";
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

// The owners one session reads, most-specific first. A session always has a project; the
// workspace and the launching user are added when known (a local-only project has no
// workspace; an offline or older launch may lack the signed-in user). Precedence everywhere
// on this path is exactly this order: user > project > workspace, then the code defaults.
export type AiScopeSet = { projectId: string; workspaceId?: string; userId?: string };

const SCOPE_RANK: Record<AiScope, number> = { user: 0, project: 1, workspace: 2 };

export function scopeOwners(scope: AiScopeSet): AiOwner[] {
  const owners: AiOwner[] = [];
  if (scope.userId) owners.push({ scope: "user", id: scope.userId });
  owners.push({ scope: "project", id: scope.projectId });
  if (scope.workspaceId) owners.push({ scope: "workspace", id: scope.workspaceId });
  return owners;
}

// One row per name across scopes: the most specific owner wins (user > project > workspace),
// so a project skill overrides a workspace one of the same name and a user skill overrides
// both — the same precedence the instruction override and the trigger union use.
function collapseByScope<T extends { owner: AiOwner }>(rows: readonly T[], key: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(key(r));
    if (!cur || SCOPE_RANK[r.owner.scope] < SCOPE_RANK[cur.owner.scope]) best.set(key(r), r);
  }
  return [...best.values()];
}

export function resolveSkills(rows: readonly AiSkill[]): Resolved[] {
  const out = new Map<string, Resolved>();
  for (const d of DEFAULT_SKILLS) out.set(d.name, { def: d, source: "default" });
  // Collapsed to one row per name first, so a workspace default-disable that a project
  // re-enables, or vice versa, is decided by the more specific scope alone.
  for (const r of collapseByScope(rows, (s) => s.name)) {
    // A disabled row is how an owner turns a default off; on a name with no default it is
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
//
// The overlay also forces `ttsr.enabled: true`: the same launch carries the session's trigger
// package via `-e`, and an operator who has TTSR switched off would otherwise get rules that
// load and silently never fire. It is a scalar, so it merges instead of replacing.
function renderOverlay(dirs: readonly string[]): string {
  const lines = dirs.map((d) => `    - ${JSON.stringify(d)}`);
  return `skills:\n  customDirectories:\n${lines.join("\n")}\nttsr:\n  enabled: true\n`;
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

// A TTSR rule fires content WITHOUT the model choosing to. TTSR monitors assistant text and
// tool arguments by default and thinking only when the scope says so — which is why a
// "the model is reasoning about X" trigger MUST name it. `operator` has no entry here at all:
// Kermanych matches that source itself, before the message ever reaches the child.
const TRIGGER_SCOPE: Record<Exclude<AiTrigger["source"], "operator">, string> = {
  assistant: "[text]",
  thinking: "[thinking]",
  tool: "[tool]",
};

export function triggersRoot(): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "triggers");
}

/**
 * A TTSR rule file. Every value is JSON-encoded, which is valid YAML and survives a pattern
 * containing `:` or `#` — a malformed rule is a hard omp startup error, not a degradation.
 */
export function renderRuleFile(t: AiTrigger, body: string): string {
  if (t.source === "operator") throw new Error(`trigger "${t.slug}" is operator-sourced: it has no rule file`);
  // `scope` is the one value that is not JSON-encoded, so it is the one that can be malformed:
  // a source outside the union (a row predating the DB constraint) would write
  // `scope: undefined`, which omp rejects at LOAD — after any write-time try/catch has already
  // succeeded. Rejected here so a bad row costs its own rule and never a launch.
  //
  // `Object.hasOwn`, not a bare `TRIGGER_SCOPE[t.source]`: the table is a plain object, so a
  // row whose source is `constructor` (or any other Object.prototype member) would read back
  // an inherited truthy value, walk straight past the guard below and interpolate a
  // stringified function into the YAML. The guard exists precisely for values outside the
  // union, so it must not be defeatable by one of them.
  const scope = Object.hasOwn(TRIGGER_SCOPE, t.source) ? TRIGGER_SCOPE[t.source] : undefined;
  if (!scope) throw new Error(`trigger "${t.slug}" has an unknown source: ${String(t.source)}`);
  const fm = [
    "---",
    `description: ${JSON.stringify(t.label)}`,
    `condition: ${JSON.stringify(t.pattern)}`,
    `scope: ${scope}`,
    `interruptMode: ${t.mode === "interrupt" ? "always" : "never"}`,
    `repeatMode: ${t.repeat === "after-gap" ? "after-gap" : "once"}`,
    ...(t.pathGlobs.length ? [`globs: ${JSON.stringify(t.pathGlobs)}`] : []),
    "---",
  ].join("\n");
  return `${fm}\n\n${body.trim()}\n`;
}

// `stale` means "the library on disk may not reflect the cloud": a failed cloud read, a failed
// repo scan, an unreadable `skills.customDirectories`, or a filesystem failure. It is never a
// reason to refuse a launch. `configPath` is set only once the overlay write succeeded.
export type Materialized = { configPath?: string; view: SkillView[]; stale?: boolean };

@Injectable()
export class SkillsService {
  constructor(private auth: AuthService) {}

  // Seams for tests: the cloud reads and the `omp` child are the parts a unit test cannot
  // perform. Each reads EVERY owner the session sees (user, project, workspace) and returns
  // the rows tagged with their owner; the resolver methods below apply precedence.
  readSkills = (scope: AiScopeSet): Promise<AiSkill[]> => this.readAll(scope, listAiSkills);
  readAssignments = (scope: AiScopeSet): Promise<AiAgentSkill[]> => this.readAll(scope, listAiAgentSkills);
  readTriggers = (scope: AiScopeSet): Promise<AiTrigger[]> => this.readAll(scope, listAiTriggers);
  readAgents = (scope: AiScopeSet): Promise<AiAgent[]> => this.readAll(scope, listAiAgents);
  readCustomDirs = (cwd: string): Promise<string[] | undefined> => readOmpCustomDirectories(cwd);

  // One cloud call per owner, under the signed-in user's JWT. A member of a project is a
  // member of its workspace and owns their own user rows, so all present owners read; an
  // offline or signed-out client fails them all, which every caller already degrades on.
  private async readAll<T>(
    scope: AiScopeSet,
    read: (client: SupabaseClient, owner: AiOwner) => Promise<T[]>,
  ): Promise<T[]> {
    const client = this.auth.cloudClient();
    const parts = await Promise.all(scopeOwners(scope).map((owner) => read(client, owner)));
    return parts.flat();
  }

  // The effective text for one of Kermanych's agents, or `undefined` when the compile-time
  // default is what must run. The override is taken from the MOST SPECIFIC scope that carries
  // one (user > project > workspace). The template is checked HERE as well as in the editor
  // because the row can OUTLIVE the template it was written against: an agent whose holes
  // change leaves every saved override behind, and neither way of being stale is visible to
  // the operator. One that lost a hole runs the agent starved of the very context it was
  // written around — no diff, no branch — and one that names a hole that no longer exists
  // makes renderInstruction throw mid-session. The default is always renderable, so a stale
  // override is dropped rather than delivered.
  async instructionFor(scope: AiScopeSet, agentId: string): Promise<string | undefined> {
    const def = agentById(agentId);
    if (!def) return undefined;
    let rows: AiAgent[];
    try {
      assertProjectId(scope.projectId);
      rows = await this.readAgents(scope);
    } catch {
      return undefined; // offline, signed out, or an id that is not a project
    }
    const mine = rows
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => SCOPE_RANK[a.owner.scope] - SCOPE_RANK[b.owner.scope]);
    const template = mine[0]?.instruction.trim();
    if (!template) return undefined;
    const { missing, unknown } = instructionErrors(def, template);
    if (missing.length === 0 && unknown.length === 0) return template;
    // Unlike a failed cloud read, this is a scope that HAS an instruction and is silently not
    // getting it — the one degradation on this path worth a line in the log.
    console.warn(
      `[skills] instruction for ${agentId} ignored (${mine[0]!.owner.scope} ${mine[0]!.owner.id}):` +
        ` missing ${missing.join(", ") || "none"}, unknown ${unknown.join(", ") || "none"}`,
    );
    return undefined;
  }

  // What one agent's instruction carries for the skills assigned to it: the block to append,
  // the view the UI labels the rows with, and the names that resolved to nothing. The
  // sequence is taken WHOLE from the most specific scope that defines one (user, else project,
  // else workspace) — not concatenated across scopes, so a skill is never glued in twice.
  // Never throws for a library reason — an agent that cannot read its assignments still runs
  // with its own instruction.
  async assignedFor(
    scope: AiScopeSet,
    agentId: string,
    cwd: string,
  ): Promise<{ block: string; view: SkillView[]; missing: string[] }> {
    assertProjectId(scope.projectId);
    let rows: AiAgentSkill[];
    try {
      rows = (await this.readAssignments(scope)).filter((r) => r.agentId === agentId);
    } catch {
      return { block: "", view: [], missing: [] }; // offline or signed out
    }
    // The winning scope is the most specific one with any row for this agent. Its rows, in
    // the operator's own order with the name as the tiebreak, are the sequence.
    const winner = rows.reduce<AiAgentSkill["owner"]["scope"] | undefined>((best, r) => {
      if (best === undefined || SCOPE_RANK[r.owner.scope] < SCOPE_RANK[best]) return r.owner.scope;
      return best;
    }, undefined);
    const chosen = rows
      .filter((r) => r.owner.scope === winner)
      .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName));
    return this.assignedForNames(
      scope,
      chosen.map((r) => r.skillName),
      cwd,
    );
  }

  // The resolution half, given names in the order they must appear. Shared with the trigger
  // path, which materialises the same bodies from a different source: precedence has exactly
  // one answer, and it lives here. Degrades rather than throws for the same reason as above.
  async assignedForNames(
    scope: AiScopeSet,
    names: readonly string[],
    cwd: string,
  ): Promise<{ block: string; view: SkillView[]; missing: string[] }> {
    assertProjectId(scope.projectId);
    // A failed CLOUD read only narrows the library to DEFAULT_SKILLS, which need neither
    // network nor sign-in, so an assigned default is still delivered. A failed REPO SCAN is
    // different: with no trustworthy shadow map, delivering the library's text could hand the
    // agent a body the repository has overridden, and "the repository always wins" outranks
    // delivering anything at all. Same degradation as an unreachable cloud, one layer up.
    const [library, repo] = await Promise.all([
      this.readSkills(scope).catch(() => [] as AiSkill[]),
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

  // Read-only: the session's EFFECTIVE library — every scope merged by precedence, with the
  // repository shadow marked. Never writes, so a settings screen cannot mutate a session's
  // library by being opened. Errors propagate on purpose: showing the defaults after a failed
  // read would tell the user their skills are gone when what failed was the read.
  //
  // The repository scan is returned ALONGSIDE the library, not folded in: a name it alone
  // defines has no row and no default, so it has no place in a list of the owned skills — but
  // it IS deliverable, because `assignedForNames` reads the repository's file for it. A caller
  // telling "assigned to something gone" from "assigned to something the repository provides"
  // cannot do it from `view` alone, and a caller wanting only the library ignores `repo`.
  async view(scope: AiScopeSet, cwd: string): Promise<ProjectSkillsPayload> {
    assertProjectId(scope.projectId);
    const rows = await this.readSkills(scope);
    const repo = await repoSkillNames(cwd);
    const view = resolveSkills(rows).map(({ def, source }) => ({
      name: def.name,
      description: def.description,
      source,
      ...(repo.has(def.name) ? { shadowedByRepo: repo.get(def.name)! } : {}),
    }));
    return { view, repo: Object.fromEntries(repo) };
  }

  // Never blocks a launch: every filesystem, cloud or config failure degrades to
  // `stale: true` with whatever is already on disk. `configPath` is absent when the overlay
  // was not written — passing omp a --config that does not exist would break the session. The
  // on-disk directory stays keyed on the PROJECT (the session's checkout is a project's), even
  // though the resolved content now merges the workspace and the user in too.
  async materialize(scope: AiScopeSet, cwd: string): Promise<Materialized> {
    assertProjectId(scope.projectId);
    const dir = join(skillsRoot(), scope.projectId);
    const overlay = join(skillsRoot(), `${scope.projectId}.config.yml`);

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
    let rows: AiSkill[] = [];
    try {
      rows = await this.readSkills(scope);
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
          // would demote an owner's own skill to the default that shares its name.
          if (cloudFailed && (await hasSkillFile(dir, def.name))) continue;
          await mkdir(join(dir, def.name), { recursive: true });
          await writeFile(join(dir, def.name, "SKILL.md"), renderSkillFile(def), "utf8");
        }
        // Runs only after every write succeeded, so a half-written library is never pruned
        // against. Removed AND newly repo-shadowed names both disappear here. Skipped when the
        // cloud failed: `resolved` is then not the real library, and pruning against it would
        // delete every cached skill.
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

  // The triggers Kermanych itself matches, in the order it tries them. The UNION of every
  // scope, deduped by slug with the most specific scope winning, then sorted by slug so two
  // patterns that both match one message always pick the same winner — a message whose outcome
  // depended on the cloud's row order would be untestable and unexplainable. Degrades to none
  // rather than throwing: an offline or signed-out operator still gets to send messages.
  async operatorTriggers(scope: AiScopeSet): Promise<AiTrigger[]> {
    assertProjectId(scope.projectId);
    try {
      const operator = (await this.readTriggers(scope)).filter((t) => t.enabled && t.source === "operator");
      return collapseByScope(operator, (t) => t.slug).sort((a, b) => a.slug.localeCompare(b.slug));
    } catch {
      return []; // offline or signed out
    }
  }

  /**
   * Lay this session's TTSR rules out as a loadable extension package. Per SESSION, not per
   * project: a rule body may carry session-specific interpolation, and the per-project config
   * overlay already taught us that a shared filename with cwd-dependent content races. The
   * rules are the UNION of every scope, deduped by slug with the most specific winning.
   *
   * Never throws for a trigger reason: a session that cannot have triggers still launches
   * without them.
   */
  async materializeTriggers(scope: AiScopeSet, sessionId: string, cwd: string): Promise<{ packagePath?: string }> {
    assertProjectId(scope.projectId);
    // The session id becomes a directory name that is then pruned with a recursive rm, so it
    // gets the same boundary check the project id gets.
    if (!isSkillName(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    const dir = join(triggersRoot(), sessionId);
    let triggers: AiTrigger[];
    try {
      // Only a source TTSR has a scope for gets a rule file: `operator` is matched by
      // Kermanych itself, and anything outside the union is a row predating the DB
      // constraint — dropped here so it costs its own rule rather than the whole package.
      const ttsr = (await this.readTriggers(scope)).filter((t) => t.enabled && Object.hasOwn(TRIGGER_SCOPE, t.source));
      triggers = collapseByScope(ttsr, (t) => t.slug);
    } catch {
      return {}; // offline or signed out
    }
    // A trigger's body is the text it fires: the operator's own instruction first, then the
    // bodies of the skills it names, in the order they were given — the instruction says what
    // to do about the match and the skills say how, so it reads in that order. `action:
    // "agent"` cannot occur here (a child has no callback into Kermanych) and is skipped.
    // An empty body is not written: a rule that fires and says nothing spends a turn and
    // makes the model investigate the rule instead of acting (design §2.6).
    const bodies = new Map<string, string>();
    for (const t of triggers) {
      if (t.action === "agent") continue;
      const { block } = await this.assignedForNames(scope, t.skills, cwd);
      const body = [t.instruction.trim(), block.trim()].filter(Boolean).join("\n\n");
      if (body) bodies.set(t.slug, body);
    }
    if (bodies.size === 0) {
      // A package left behind would keep firing rules whose triggers are gone, and an empty
      // one would hand omp a `-e` with nothing in it.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return {};
    }
    try {
      await mkdir(join(dir, "rules"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify(
          { name: `kermanych-triggers-${sessionId}`, version: "0.0.0", omp: { extensions: ["./index.js"] } },
          null,
          2,
        ),
        "utf8",
      );
      // A package is only loaded when its entry point resolves, and the sibling `rules/`
      // directory is only discovered for a loaded package. Hence a no-op extension.
      await writeFile(join(dir, "index.js"), "export default function () {}\n", "utf8");
      for (const t of triggers) {
        const body = bodies.get(t.slug);
        if (body) await writeFile(join(dir, "rules", `${t.slug}.md`), renderRuleFile(t, body), "utf8");
      }
      // Only after every write succeeded, so a half-written package is never pruned against.
      // A rule whose trigger was deleted, disabled or left dangling disappears here.
      for (const e of await readEntries(join(dir, "rules"))) {
        if (e.isFile() && !bodies.has(e.name.replace(/\.md$/, ""))) {
          await rm(join(dir, "rules", e.name), { force: true }).catch(() => {});
        }
      }
    } catch {
      // EACCES, ENOSPC, EROFS, or a plain file where the package should be. A partial package
      // is worse than none: omp fails to start on a malformed rule, so it is removed outright.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return {};
    }
    return { packagePath: dir };
  }
}
