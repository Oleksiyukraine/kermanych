// The «MCP-сервери» editor's form (docs/specs/2026-11-14-project-mcp-servers.md, decisions 5–6):
// a server definition as rows the operator edits, and back. A row marked «секрет» never shows
// its value: the file holds `${VAR}`, the value lives in the project's `.env`, and an empty
// value on save leaves `.env` as it is.
import {
  MCP_NAME_RE,
  MCP_VAR_NAME_RE,
  mcpSecretVarName,
  type CodexTable,
  type McpSaveBody,
  type McpServerDef,
} from '@kermanych/core';

/** One environment variable (local command) or header (URL). */
export type McpPair = {
  key: string;
  value: string;
  secret: boolean;
  /** The `.env` variable a secret is stored under. */
  varName: string;
  /** `Authorization: Bearer ${VAR}` — the variable holds the token alone. */
  bearer: boolean;
  /** The secret was already in the file: an empty value keeps what `.env` has. */
  stored: boolean;
};

export type McpDraft = {
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  /** One argument per line: an argument may hold spaces. */
  args: string;
  url: string;
  sse: boolean;
  pairs: McpPair[];
};

const WHOLE_VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_VAR = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function emptyMcpDraft(): McpDraft {
  return { name: '', kind: 'stdio', command: '', args: '', url: '', sse: false, pairs: [] };
}

export function emptyMcpPair(): McpPair {
  return { key: '', value: '', secret: true, varName: '', bearer: false, stored: false };
}

/** The form for a stored server: a whole-value placeholder reads as a stored secret. */
export function mcpDraftFrom(name: string, def: McpServerDef): McpDraft {
  const map = def.kind === 'stdio' ? def.env : def.headers;
  const pairs = Object.entries(map).map(([key, value]): McpPair => {
    const bearer = def.kind === 'http' ? BEARER_VAR.exec(value) : null;
    const whole = WHOLE_VAR.exec(value);
    const varName = bearer?.[1] ?? whole?.[1];
    return varName
      ? { key, value: '', secret: true, varName, bearer: !!bearer, stored: true }
      : { key, value, secret: false, varName: '', bearer: false, stored: false };
  });
  return def.kind === 'stdio'
    ? { name, kind: 'stdio', command: def.command, args: def.args.join('\n'), url: '', sse: false, pairs }
    : { name, kind: 'http', command: '', args: '', url: def.url, sse: !!def.sse, pairs };
}

/**
 * The variable a secret row is stored under when the operator has not named one: an env
 * variable keeps its own name (so codex can forward it, `env_vars`), a header gets
 * `<SERVER>_<HEADER>`.
 */
export function mcpPairVarName(draft: McpDraft, pair: McpPair): string {
  if (pair.varName.trim()) return pair.varName.trim();
  return draft.kind === 'stdio' ? pair.key.trim() : mcpSecretVarName(draft.name.trim() || 'mcp', pair.key.trim());
}

export type McpDraftProblem = 'name' | 'command' | 'url' | 'key' | 'duplicateKey' | 'varName';

/** The save body for the form, or the first thing wrong with it. */
export function mcpDraftToSave(draft: McpDraft): { body: McpSaveBody } | { problem: McpDraftProblem; detail?: string } {
  if (!MCP_NAME_RE.test(draft.name.trim())) return { problem: 'name' };
  if (draft.kind === 'stdio' && !draft.command.trim()) return { problem: 'command' };
  if (draft.kind === 'http' && !draft.url.trim()) return { problem: 'url' };
  const map: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const pair of draft.pairs) {
    const key = pair.key.trim();
    if (!key && !pair.value) continue; // a row added and left blank
    if (!key) return { problem: 'key' };
    if (key in map) return { problem: 'duplicateKey', detail: key };
    if (!pair.secret) {
      map[key] = pair.value;
      continue;
    }
    const varName = mcpPairVarName(draft, pair);
    if (!MCP_VAR_NAME_RE.test(varName)) return { problem: 'varName', detail: varName };
    // A token pasted with its scheme («Bearer lin_…») into Authorization is stored alone, so the
    // file says `Bearer ${VAR}` — the form codex's `bearer_token_env_var` takes.
    const pasted = /^Bearer\s+(.+)$/.exec(pair.value);
    const bearer = draft.kind === 'http' && key.toLowerCase() === 'authorization' && (pair.bearer || !!pasted);
    map[key] = bearer ? `Bearer \${${varName}}` : `\${${varName}}`;
    const value = bearer && pasted ? pasted[1]! : pair.value;
    if (value) secrets[varName] = value;
  }
  const def: McpServerDef =
    draft.kind === 'stdio'
      ? {
          kind: 'stdio',
          command: draft.command.trim(),
          args: draft.args.split('\n').map((a) => a.trim()).filter(Boolean),
          env: map,
        }
      : { kind: 'http', url: draft.url.trim(), headers: map, ...(draft.sse ? { sse: true as const } : {}) };
  return { body: { def, ...(Object.keys(secrets).length ? { secrets } : {}) } };
}

/** A server's command line or URL, as one line for the list. */
export function mcpDefLine(def: McpServerDef): string {
  return def.kind === 'stdio' ? [def.command, ...def.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ') : def.url;
}

/** A codex table as the lines it reads as in `.codex/config.toml`, for the «differs» comparison. */
export function codexTableText(table: CodexTable): string {
  const value = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(value).join(', ')}]`
      : v && typeof v === 'object'
        ? `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${value(x)}`).join(', ')} }`
        : JSON.stringify(v);
  return Object.entries(table)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${value(v)}`)
    .join('\n');
}
