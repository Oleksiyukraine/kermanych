// apps/api/src/mcp/mcp-files.ts
// Reading and writing the repository files harnesses take MCP servers from
// (docs/specs/2026-11-14-project-mcp-servers.md). The editor writes two of them: `.mcp.json`
// (JSON, rewritten whole with its indentation kept) and `.codex/config.toml` (TOML, where only
// the one server's table is replaced in the text, so comments and the rest of the file stay byte
// for byte). Every other file is read only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  CODEX_TABLE_KEYS,
  MCP_CODEX_FILE,
  MCP_FILES,
  mcpDefFromCodex,
  mcpDefFromJson,
  mcpVarRefs,
  type CodexTable,
  type McpFile,
  type McpServerDef,
} from "@kermanych/core";
import { parseEnv } from "../env/env-text";

/** The nearest folder at or above `dir` that holds `.git` (a folder, or a worktree's file). */
export function findGitRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

export type McpFileServer = { def: McpServerDef; raw: Record<string, unknown> };
export type McpFileRead = { servers: Map<string, McpFileServer> } | { error: string };

type JsonDoc = { doc: Record<string, unknown>; servers: Record<string, unknown>; indent: string | number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// `mcpServers` everywhere but VS Code, whose file keys them `servers` (or `mcp.servers`).
function jsonServers(doc: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(doc.mcpServers)) return doc.mcpServers;
  if (isRecord(doc.servers)) return doc.servers;
  if (isRecord(doc.mcp) && isRecord(doc.mcp.servers)) return doc.mcp.servers;
  return {};
}

function parseJsonDoc(text: string): JsonDoc {
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error("the file is not a JSON object");
  const indented = /^([ \t]+)"/m.exec(text)?.[1];
  return { doc, servers: jsonServers(doc), indent: indented?.startsWith("\t") ? "\t" : (indented?.length ?? 2) };
}

function codexServers(text: string): Record<string, unknown> {
  const doc = parseToml(text);
  return isRecord(doc.mcp_servers) ? doc.mcp_servers : {};
}

/**
 * One file's servers; null when the file is absent; an error when it does not parse. Synchronous,
 * like the other reads here: a launch reads these few small files between its argv and its
 * spawn, and the spawn stays in the same tick as `start()` (rpc-session.ts's renice contract).
 */
export function readMcpFile(dir: string, file: McpFile): McpFileRead | null {
  const path = join(dir, file);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    const text = readFileSync(path, "utf8");
    const toml = file === MCP_CODEX_FILE;
    const raws = toml ? codexServers(text) : parseJsonDoc(text).servers;
    const servers = new Map<string, McpFileServer>();
    for (const [name, raw] of Object.entries(raws)) {
      if (!isRecord(raw)) continue;
      const def = toml ? mcpDefFromCodex(raw) : mcpDefFromJson(raw);
      if (def) servers.set(name, { def, raw });
    }
    return { servers };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.kmq-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const JSON_MANAGED = ["type", "command", "args", "env", "url", "headers"];

/**
 * Set (or with `def` null, remove) one server of a JSON MCP file. The server's other keys
 * (`timeout`, `enabled`, `oauth`, …) and the rest of the file are kept; a missing file is created
 * as `{ "mcpServers": {} }`.
 */
export async function writeJsonServer(dir: string, file: McpFile, name: string, def: McpServerDef | null): Promise<void> {
  const path = join(dir, file);
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const parsed: JsonDoc = text.trim() ? parseJsonDoc(text) : { doc: {}, servers: {}, indent: 2 };
  // A file with no server map yet gets the standard key; otherwise write into the one it has.
  if (!isRecord(parsed.doc.mcpServers) && !isRecord(parsed.doc.servers) && !(isRecord(parsed.doc.mcp) && isRecord(parsed.doc.mcp.servers))) {
    parsed.doc.mcpServers = parsed.servers;
  }
  if (!def) {
    delete parsed.servers[name];
  } else {
    const old = isRecord(parsed.servers[name]) ? parsed.servers[name] : {};
    const rest = Object.fromEntries(Object.entries(old).filter(([k]) => !JSON_MANAGED.includes(k)));
    parsed.servers[name] =
      def.kind === "stdio"
        ? {
            type: "stdio",
            command: def.command,
            ...(def.args.length ? { args: def.args } : {}),
            ...(Object.keys(def.env).length ? { env: def.env } : {}),
            ...rest,
          }
        : {
            type: def.sse ? "sse" : "http",
            url: def.url,
            ...(Object.keys(def.headers).length ? { headers: def.headers } : {}),
            ...rest,
          };
  }
  await writeAtomic(path, JSON.stringify(parsed.doc, null, parsed.indent) + "\n");
}

/** The managed keys of `name`'s codex table in `dir`, or null when it has none. */
export async function readCodexTable(dir: string, name: string): Promise<Record<string, unknown> | null> {
  const path = join(dir, MCP_CODEX_FILE);
  if (!existsSync(path)) return null;
  const raw = codexServers(await readFile(path, "utf8"))[name];
  return isRecord(raw) ? raw : null;
}

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

// The dotted key of a table header split into its parts: `mcp_servers."a.b".env` → [mcp_servers, a.b, env].
function headerPath(key: string): string[] {
  const parts: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < key.length && (m = re.exec(key))) {
    const p = m[1]!;
    parts.push(p.startsWith('"') ? (JSON.parse(p) as string) : p.startsWith("'") ? p.slice(1, -1) : p);
  }
  return parts;
}

/**
 * `.codex/config.toml` with `name`'s table set to the managed keys of `table` (or with `table`
 * null, removed). The keys Kermanych does not manage (`startup_timeout_sec`, `tools.*`, …) are
 * kept; the server's blocks are cut out of the text and its new blocks written where the first
 * one was (or appended). The result is parsed back: if anything but this server changed, or the
 * server's table is written inline where no block can be cut, it throws instead of writing.
 */
export function replaceCodexTableText(text: string, name: string, table: CodexTable | null): string {
  const before = parseToml(text);
  const servers = isRecord(before.mcp_servers) ? before.mcp_servers : {};
  const old = isRecord(servers[name]) ? servers[name] : undefined;
  let next: Record<string, unknown> | undefined;
  if (table) {
    const rest = Object.fromEntries(Object.entries(old ?? {}).filter(([k]) => !(CODEX_TABLE_KEYS as readonly string[]).includes(k)));
    next = { ...Object.fromEntries(Object.entries(table).filter(([, v]) => v !== undefined)), ...rest };
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  let at = -1;
  let inServer = false;
  // Blank lines at the end of the server's block separate the NEXT table; they stay with it.
  let blanks: string[] = [];
  for (const line of lines) {
    const h = HEADER_RE.exec(line);
    if (h) {
      const path = headerPath(h[1]!);
      const wasServer = inServer;
      inServer = path.length >= 2 && path[0] === "mcp_servers" && path[1] === name;
      if (wasServer && !inServer) kept.push(...blanks);
      blanks = [];
      if (inServer && at < 0) at = kept.length;
    }
    if (!inServer) kept.push(line);
    else if (!line.trim()) blanks.push(line);
    else blanks = [];
  }

  if (old && at < 0) throw new Error(`the codex table of «${name}» is written inline in ${MCP_CODEX_FILE}; edit that file by hand`);
  let out: string;
  if (!next) {
    out = kept.join("\n");
  } else {
    const block = stringifyToml({ mcp_servers: { [name]: next } }).trimEnd();
    if (at < 0) {
      const body = kept.join("\n").trimEnd();
      out = (body ? `${body}\n\n` : "") + block + "\n";
    } else {
      const after = kept.slice(at);
      out = [...kept.slice(0, at), ...block.split("\n"), ...(after.length && after[0]!.trim() ? [""] : []), ...after].join("\n");
    }
  }
  if (out && !out.endsWith("\n")) out += "\n";

  // smol-toml builds null-prototype objects; a JSON round trip compares the data alone.
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as unknown;
  const parsed = parseToml(out);
  const afterServers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const rest = (doc: Record<string, unknown>, s: Record<string, unknown>) => {
    const { [name]: _drop, ...others } = s;
    const { mcp_servers: _ms, ...top } = doc;
    return plain({ top, others });
  };
  if (!isDeepStrictEqual(rest(parsed, afterServers), rest(before, servers)) || !isDeepStrictEqual(plain(afterServers[name]), plain(next))) {
    throw new Error(`${MCP_CODEX_FILE} has a layout Kermanych cannot edit safely; edit the «${name}» table by hand`);
  }
  return out;
}

/** Set or remove `name`'s codex table in `<dir>/.codex/config.toml`. Removing from a missing file is a no-op. */
export async function writeCodexTable(dir: string, name: string, table: CodexTable | null): Promise<void> {
  const path = join(dir, MCP_CODEX_FILE);
  if (!existsSync(path) && !table) return;
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeAtomic(path, replaceCodexTableText(text, name, table));
}

/** Remove `name` from one file of any kind. */
export async function removeServer(dir: string, file: McpFile, name: string): Promise<void> {
  if (file === MCP_CODEX_FILE) await writeCodexTable(dir, name, null);
  else await writeJsonServer(dir, file, name, null);
}

/** `<dir>/.env` as a map; empty when there is none. */
export function readDotenv(dir: string): Record<string, string> {
  const path = join(dir, ".env");
  if (!existsSync(path)) return {};
  return Object.fromEntries(parseEnv(readFileSync(path, "utf8")).map((e) => [e.key, e.value]));
}

/**
 * The variables a harness starting in `dir` needs for its MCP servers, with their values from
 * `dir`'s `.env` (decision 6). Only referenced keys: the whole `.env` would also reach every
 * subprocess and MCP server the agent starts. The files are read at `dir` and at its git root,
 * because a chat starts in a bound subfolder. Never throws: a launch must not fail over this.
 */
export function mcpLaunchEnv(dir: string): Record<string, string> {
  try {
    const root = findGitRoot(dir);
    const dirs = root && root !== dir ? [root, dir] : [dir];
    const names = new Set<string>();
    for (const d of dirs) {
      for (const file of MCP_FILES) {
        const read = readMcpFile(d, file);
        if (!read || "error" in read) continue;
        for (const { def } of read.servers.values()) for (const v of mcpVarRefs(def)) names.add(v.name);
      }
    }
    if (!names.size) return {};
    const dotenv = readDotenv(dir);
    return Object.fromEntries(Object.entries(dotenv).filter(([k, v]) => names.has(k) && v !== ""));
  } catch {
    return {};
  }
}
