// Reading skills that live on this machine's disk, for the «Навички» import picker and the
// repository block of the library pane (spec: docs/specs/2026-10-22-skill-import.md).
// Read-only: nothing here writes, and nothing here is on a session's launch path.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import {
  normaliseSkillName,
  type SkillImportCandidate,
  type SkillImportRead,
  type SkillImportRoot,
  type SkillImportScan,
} from "@kermanych/core";

const SKILL_FILE = "SKILL.md";

// The home-directory roots harnesses treat as «the user's skills», one level deep. Claude.ai's
// synced skills (`~/.claude/skills/synced/<bucket>/…`) sit a level deeper and the Claude plugin
// cache elsewhere: other tools manage those, so they are reachable through «Інша тека…» only.
export const HOME_SKILL_ROOTS = [".omp/agent/skills", ".claude/skills", ".agents/skills", ".codex/skills"] as const;

// How many of a skill's other files are named; the rest are only counted.
const EXTRA_SHOWN = 20;
// The walk over a skill folder stops counting here: a skill that vendors a whole tree is
// reported as «at least this many», never walked to the end.
const EXTRA_WALK_LIMIT = 2000;
// A SKILL.md larger than this is not a skill body anyone means to paste into a prompt.
const MAX_SKILL_BYTES = 1 << 20;
// Folders never worth listing as a skill's files.
const SKIP_DIRS: Record<string, true> = { ".git": true, node_modules: true };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type ParsedSkillFile = { name?: string; description: string; body: string; frontmatterError?: true };

// The frontmatter as YAML (JSON schema: no dates, no custom tags), the body as everything after
// it. The description is a one-line label in omp's skill list and in the UI, so a block scalar
// is collapsed to single spaces. A frontmatter that does not parse is not fatal: the body is
// still the body, and the caller says so instead of guessing a description.
export function parseSkillFile(text: string): ParsedSkillFile {
  const src = text.replace(/^\uFEFF/, "");
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { description: "", body: src };
  const body = src.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
  let fm: unknown;
  try {
    fm = load(m[1] ?? "", { schema: JSON_SCHEMA });
  } catch {
    return { description: "", body, frontmatterError: true };
  }
  if (fm === null || fm === undefined) return { description: "", body };
  if (typeof fm !== "object" || Array.isArray(fm)) return { description: "", body, frontmatterError: true };
  const rec = fm as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const description = typeof rec.description === "string" ? rec.description.replace(/\s+/g, " ").trim() : "";
  return { ...(name ? { name } : {}), description, body };
}

// Whether `dir` holds a SKILL.md FILE. stat follows a linked-in skill folder, as repoSkillNames
// does; any failure reads as «no skill here», because this only decides what to offer.
export async function hasSkillFile(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, SKILL_FILE))).isFile();
  } catch {
    return false;
  }
}

// The skill folder's other files, relative, sorted. Symlinks are listed, never followed: a
// link out of the folder is still a file the copy will not carry.
async function extraFiles(dir: string): Promise<{ files: string[]; count: number }> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= EXTRA_WALK_LIMIT) return;
      const full = join(at, e.name);
      if (e.isDirectory()) {
        if (!Object.hasOwn(SKIP_DIRS, e.name)) await walk(full);
        continue;
      }
      if (at === dir && e.name === SKILL_FILE) continue;
      found.push(relative(dir, full));
    }
  };
  await walk(dir);
  found.sort((a, b) => a.localeCompare(b));
  return { files: found.slice(0, EXTRA_SHOWN), count: found.length };
}

// One skill folder, read whole. Throws when the folder holds no readable SKILL.md or it is
// larger than any body worth importing — the caller decides whether that is an error or a skip.
export async function readSkillDir(dir: string): Promise<SkillImportRead> {
  const file = join(dir, SKILL_FILE);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  if (info.size > MAX_SKILL_BYTES) throw new Error(`${file} is larger than ${MAX_SKILL_BYTES} bytes`);
  const parsed = parseSkillFile(await readFile(file, "utf8"));
  const name = parsed.name ?? basename(dir);
  const extra = await extraFiles(dir);
  return {
    name,
    suggestedName: normaliseSkillName(name),
    description: parsed.description,
    dir,
    bytes: info.size,
    extraFiles: extra.files,
    extraCount: extra.count,
    ...(parsed.frontmatterError ? { frontmatterError: true as const } : {}),
    body: parsed.body,
  };
}

// The skills one level under `root`: `<root>/<name>/SKILL.md`, the layout every harness scans.
// Dot-entries are bookkeeping (`.staging`, `.bucket-…`), not skills. A skill whose SKILL.md
// cannot be read is left out rather than failing the whole root. A root that is not there
// rejects with ENOENT, so the caller can tell «absent» from «empty».
export async function scanSkillRoot(root: string): Promise<SkillImportCandidate[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: SkillImportCandidate[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(root, e.name);
    if (!(await hasSkillFile(dir))) continue;
    try {
      const { body: _body, ...candidate } = await readSkillDir(dir);
      out.push(candidate);
    } catch {
      // unreadable or oversized: not offered
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// A folder the operator chose: itself a skill, or a root of several. Neither is an empty list,
// which the picker reports as «тут немає навичок». Rejects when the folder cannot be read.
export async function scanSkillFolder(path: string): Promise<SkillImportScan> {
  if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a directory`);
  if (await hasSkillFile(path)) {
    const { body: _body, ...candidate } = await readSkillDir(path);
    return { path, skills: [candidate] };
  }
  return { path, skills: await scanSkillRoot(path) };
}

// The standard home roots that exist on this machine. An absent root is not news and is left
// out; a root that exists but cannot be read is listed with its error.
export async function homeSkillRoots(): Promise<SkillImportRoot[]> {
  const home = homedir();
  const out: SkillImportRoot[] = [];
  for (const rel of HOME_SKILL_ROOTS) {
    const path = join(home, rel);
    const label = `~/${rel}`;
    try {
      out.push({ label, path, skills: await scanSkillRoot(path) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      out.push({ label, path, skills: [], error: (err as Error).message });
    }
  }
  return out;
}

// A repository skill's description, for the library pane's «З репозиторію» block. '' on any
// failure: the block still lists the name and the path.
export async function skillFileDescription(file: string): Promise<string> {
  try {
    return parseSkillFile(await readFile(file, "utf8")).description;
  } catch {
    return "";
  }
}
