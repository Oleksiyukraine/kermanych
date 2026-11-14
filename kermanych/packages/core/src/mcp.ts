// The project's MCP servers, as «ШІ-команда → MCP-сервери» shows and edits them
// (docs/specs/2026-11-14-project-mcp-servers.md). Pure data and translation: no fs, no process.
//
// The repository file is the only copy (decision 1). Each harness reads its own files, so the
// view merges them by server name and says which harness sees which server; the editor writes
// `.mcp.json` and mirrors the server into `.codex/config.toml`, because codex reads nothing else.

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The repository files a harness reads MCP servers from, relative to the checkout's git root. */
export const MCP_FILES = [
  ".mcp.json",
  "mcp.json",
  ".omp/mcp.json",
  ".claude/mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".codex/config.toml",
] as const;
export type McpFile = (typeof MCP_FILES)[number];

/** The file the editor writes: the one both claude and omp read. */
export const MCP_JSON_FILE: McpFile = ".mcp.json";
/** The file the editor mirrors into for codex. */
export const MCP_CODEX_FILE: McpFile = ".codex/config.toml";

export const MCP_HARNESSES = ["omp", "claude", "codex"] as const;
export type McpHarness = (typeof MCP_HARNESSES)[number];

/**
 * Which harness reads a file. omp reads all of them (its own, the root fallback, and the ones it
 * imports from claude, Cursor, VS Code and codex); claude reads only the root `.mcp.json`; codex
 * only `.codex/config.toml` (of a trusted folder — Kermanych trusts the session's folder).
 */
export function mcpHarnessesFor(file: McpFile): McpHarness[] {
  if (file === MCP_JSON_FILE) return ["omp", "claude"];
  if (file === MCP_CODEX_FILE) return ["omp", "codex"];
  return ["omp"];
}

/** The harnesses that see a server defined in these files, in MCP_HARNESSES order. */
export function mcpSeenBy(files: readonly McpFile[]): McpHarness[] {
  const seen = new Set(files.flatMap(mcpHarnessesFor));
  return MCP_HARNESSES.filter((h) => seen.has(h));
}

/**
 * One server, as much of it as the editor shows. Fields the form does not know (`timeout`,
 * `enabled`, `oauth`, …) stay in the file untouched on save; they are not carried here.
 */
export type McpServerDef =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string>; sse?: true };

// `${VAR}` and `${VAR:-default}`: the forms claude and omp expand. The global copy is only for
// matchAll/replace, which never leave it mid-string; `.test` uses the stateless one.
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const HAS_PLACEHOLDER_RE = new RegExp(PLACEHOLDER_RE.source);
const WHOLE_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_VAR_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const MCP_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasPlaceholder(s: string): boolean {
  return HAS_PLACEHOLDER_RE.test(s);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

/** A server entry of a JSON file (`mcpServers.<name>`, VS Code's `servers.<name>`), or null. */
export function mcpDefFromJson(raw: unknown): McpServerDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url === "string") {
    return { kind: "http", url: r.url, headers: stringMap(r.headers), ...(r.type === "sse" ? { sse: true as const } : {}) };
  }
  if (typeof r.command === "string") return { kind: "stdio", command: r.command, args: strings(r.args), env: stringMap(r.env) };
  return null;
}

/** The `[mcp_servers.<name>]` keys Kermanych writes; every other key of a table is left alone. */
export type CodexTable = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  env_vars?: string[];
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
};
export const CODEX_TABLE_KEYS = ["command", "args", "env", "env_vars", "url", "bearer_token_env_var", "http_headers", "env_http_headers"] as const;

/** The keys of a parsed codex table that Kermanych manages, normalised (`env_vars` to names). */
export function codexKnown(raw: Record<string, unknown>): CodexTable {
  const t: CodexTable = {};
  if (Array.isArray(raw.env_vars)) {
    // A plain name, or `{ name, source }` (codex's remote-executor form).
    t.env_vars = raw.env_vars.flatMap((v: unknown) =>
      typeof v === "string" ? [v] : v && typeof v === "object" && "name" in v && typeof v.name === "string" ? [v.name] : [],
    );
  }
  if (typeof raw.command === "string") t.command = raw.command;
  if (Array.isArray(raw.args)) t.args = strings(raw.args);
  if (raw.env && typeof raw.env === "object") t.env = stringMap(raw.env);
  if (typeof raw.url === "string") t.url = raw.url;
  if (typeof raw.bearer_token_env_var === "string") t.bearer_token_env_var = raw.bearer_token_env_var;
  if (raw.http_headers && typeof raw.http_headers === "object") t.http_headers = stringMap(raw.http_headers);
  if (raw.env_http_headers && typeof raw.env_http_headers === "object") t.env_http_headers = stringMap(raw.env_http_headers);
  return t;
}

/** A codex table read as the same shape the JSON files give, so the two compare and copy. */
export function mcpDefFromCodex(raw: Record<string, unknown>): McpServerDef | null {
  const t = codexKnown(raw);
  if (t.url !== undefined) {
    const headers: Record<string, string> = { ...(t.http_headers ?? {}) };
    for (const [h, v] of Object.entries(t.env_http_headers ?? {})) headers[h] = `\${${v}}`;
    if (t.bearer_token_env_var) headers.Authorization = `Bearer \${${t.bearer_token_env_var}}`;
    return { kind: "http", url: t.url, headers };
  }
  if (t.command !== undefined) {
    const env: Record<string, string> = { ...(t.env ?? {}) };
    for (const name of t.env_vars ?? []) env[name] = `\${${name}}`;
    return { kind: "stdio", command: t.command, args: t.args ?? [], env };
  }
  return null;
}

/** Why a server cannot be written for codex, which expands no `${VAR}` of its own. */
export type McpCodexGap = "command" | "args" | "env" | "url" | "header" | "sse";

/**
 * The codex table for a server (decision 5's mapping), or why there is none. A variable reaches
 * codex only by name — `env_vars` for a stdio server, `bearer_token_env_var` / `env_http_headers`
 * for an HTTP one — so a placeholder anywhere else has no codex form.
 */
export function mcpToCodex(def: McpServerDef): { table: CodexTable } | { gap: McpCodexGap } {
  if (def.kind === "stdio") {
    if (hasPlaceholder(def.command)) return { gap: "command" };
    if (def.args.some(hasPlaceholder)) return { gap: "args" };
    const table: CodexTable = { command: def.command };
    if (def.args.length) table.args = [...def.args];
    const env: Record<string, string> = {};
    const vars: string[] = [];
    for (const [k, v] of Object.entries(def.env)) {
      if (!hasPlaceholder(v)) env[k] = v;
      else if (v === `\${${k}}`) vars.push(k);
      else return { gap: "env" };
    }
    if (Object.keys(env).length) table.env = env;
    if (vars.length) table.env_vars = vars;
    return { table };
  }
  if (def.sse) return { gap: "sse" };
  if (hasPlaceholder(def.url)) return { gap: "url" };
  const table: CodexTable = { url: def.url };
  const literal: Record<string, string> = {};
  const fromEnv: Record<string, string> = {};
  for (const [h, v] of Object.entries(def.headers)) {
    const bearer = h.toLowerCase() === "authorization" ? BEARER_VAR_RE.exec(v) : null;
    const whole = WHOLE_VAR_RE.exec(v);
    if (!hasPlaceholder(v)) literal[h] = v;
    else if (bearer && !table.bearer_token_env_var) table.bearer_token_env_var = bearer[1]!;
    else if (whole) fromEnv[h] = whole[1]!;
    else return { gap: "header" };
  }
  if (Object.keys(literal).length) table.http_headers = literal;
  if (Object.keys(fromEnv).length) table.env_http_headers = fromEnv;
  return { table };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

/** Whether two codex tables agree on the keys Kermanych manages (empty maps and lists = absent). */
export function codexTablesEqual(a: CodexTable, b: CodexTable): boolean {
  const strip = (t: CodexTable) =>
    Object.fromEntries(
      Object.entries(t).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : v && typeof v === "object" && Object.keys(v).length === 0)),
    );
  return JSON.stringify(canonical(strip(a))) === JSON.stringify(canonical(strip(b)));
}

/** Every variable a server needs, in first-use order; `optional` when each use has a default. */
export function mcpVarRefs(def: McpServerDef): { name: string; optional: boolean }[] {
  const texts = def.kind === "stdio" ? [def.command, ...def.args, ...Object.values(def.env)] : [def.url, ...Object.values(def.headers)];
  const seen = new Map<string, boolean>();
  for (const s of texts) {
    for (const m of s.matchAll(PLACEHOLDER_RE)) {
      const optional = m[2] !== undefined;
      seen.set(m[1]!, (seen.get(m[1]!) ?? true) && optional);
    }
  }
  return [...seen].map(([name, optional]) => ({ name, optional }));
}

/** `${VAR}` / `${VAR:-default}` expanded from `env` the way claude and omp do; unset → '' or the default. */
export function expandMcpVars(s: string, env: Record<string, string | undefined>): string {
  return s.replace(PLACEHOLDER_RE, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : (fallback ?? "");
  });
}

export function expandMcpDef(def: McpServerDef, env: Record<string, string | undefined>): McpServerDef {
  const x = (s: string) => expandMcpVars(s, env);
  const map = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v)]));
  return def.kind === "stdio"
    ? { kind: "stdio", command: x(def.command), args: def.args.map(x), env: map(def.env) }
    : { ...def, url: x(def.url), headers: map(def.headers) };
}

/** Where a variable a server needs has a value: the project's `.env`, the api's environment, or nowhere. */
export type McpVarState = "env-file" | "process" | "unset";
export type McpVar = { name: string; optional: boolean; state: McpVarState };

/** The codex mirror of an editable server: in place, not written yet, different by hand, or impossible. */
export type McpCodexState = { state: "mirrored" | "missing" | "differs" } | { state: "gap"; gap: McpCodexGap };

export type McpServerRow = {
  name: string;
  /** The `.mcp.json` definition when there is one, else the first file's. */
  def: McpServerDef;
  files: McpFile[];
  /** `subdir`: found only under a bound subfolder, where no session's harness starts. */
  location: "root" | "subdir";
  /** At the root and in `.mcp.json`: the editor owns it. */
  editable: boolean;
  seenBy: McpHarness[];
  /** Only for editable rows. */
  codex?: McpCodexState;
  vars: McpVar[];
};

export type McpFileError = { file: string; error: string };

export type McpProjectView = {
  /** The checkout's git root, where every session's harness starts. */
  root: string;
  /** `localRepoPath` relative to `root`, '' when they are the same folder. */
  subdir: string;
  servers: McpServerRow[];
  /** The editor's files that `git status` lists as changed or new. */
  uncommitted: McpFile[];
  /** Whether the project's `.env` is ignored by git (a secret goes there). */
  envIgnored: boolean;
  errors: McpFileError[];
};

export type McpSaveBody = {
  def: McpServerDef;
  /** Values for the `.env` of the project, by variable name. */
  secrets?: Record<string, string>;
  /** Replace a codex table that differs from the translation (after the operator confirmed). */
  replaceCodex?: boolean;
};

/** A write that would replace a hand-written codex table: both tables, for the operator to compare. */
export type McpCodexConflict = { current: CodexTable; next: CodexTable };

/** What a write answers: the fresh view, or the codex table it stopped at (nothing was written). */
export type McpWriteResult = { view: McpProjectView } | { conflict: McpCodexConflict };

export type McpCheckResult =
  | { ok: true; tools: { name: string; description: string }[]; ms: number }
  | { ok: false; error: string; auth?: true; stderr: string[]; ms: number };

/** The `.env` variable a secret header is stored under: `<SERVER>_<HEADER>`, upper snake case. */
export function mcpSecretVarName(server: string, key: string): string {
  const name = `${server}_${key}`.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  return /^[A-Z_]/.test(name) ? name : `MCP_${name}`;
}
