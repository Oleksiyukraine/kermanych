// apps/api/src/env/env-text.ts
// Pure, dependency-free .env text helpers. Values are single-line; inline
// comments after a value are treated as part of the value (v1 simplification).
import type { EnvEntry } from "@kermanych/core";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") {
    return v.slice(1, -1);
  }
  return v;
}

function needsQuote(v: string): boolean {
  return v === "" || /[\s"'`$&|;<>()#\\]/.test(v);
}

function serializeValue(v: string): string {
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function keyOf(line: string): string | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  if (line.trim().startsWith("#")) return null;
  const key = line.slice(0, eq).trim();
  return KEY_RE.test(key) ? key : null;
}

export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const key = keyOf(line);
    if (!key) continue;
    const value = unquote(line.slice(line.indexOf("=") + 1).trim());
    out.push({ key, value });
  }
  return out;
}

export function applyEnvEdits(
  text: string,
  edits: { set?: Record<string, string>; remove?: string[] },
): string {
  const set = edits.set ?? {};
  const remove = new Set(edits.remove ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text ? text.split(/\r?\n/) : []) {
    const key = keyOf(line);
    if (key && remove.has(key)) continue;
    if (key && key in set) {
      out.push(`${key}=${serializeValue(set[key])}`);
      seen.add(key);
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  for (const [k, v] of Object.entries(set)) {
    if (!seen.has(k)) out.push(`${k}=${serializeValue(v)}`);
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
