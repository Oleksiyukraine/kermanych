// apps/api/src/preview/preview-dotenv.ts
// The session directory's `.env`, as the environment of every preview step
// (docs/specs/2026-11-08-synergy-login-and-session-env.md, decision 1). A dev server that reads
// `process.env` and not the file (Quasar's app-vite 1 `build.env`, a plain node server) sees the
// operator's «Змінні» too. Below Kermanych's own variables and a service's `env`, above the
// api's inherited environment.
//
// Frameworks that load env files themselves (Vite, Next.js, Quasar app-vite 2) let a variable
// already in the environment win over every file. Exporting a key would then silence its
// override, so a key is left out when:
// - an overlay those frameworks read with a higher priority than `.env` sets it too;
// - its value refers to another variable (`$`): they expand it, an exported literal they would not;
// - it is NODE_ENV: each command sets it for itself (dev vs build).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "../env/env-text";

const OVERLAYS = [".env.local", ".env.development", ".env.development.local", ".env.dev", ".env.dev.local"];

async function keysOf(dir: string, file: string): Promise<string[]> {
  const text = await readFile(join(dir, file), "utf8").catch(() => "");
  return parseEnv(text).map((e) => e.key);
}

export async function previewDotenv(dir: string): Promise<Record<string, string>> {
  const text = await readFile(join(dir, ".env"), "utf8").catch(() => null);
  if (text === null) return {};
  const shadowed = new Set((await Promise.all(OVERLAYS.map((f) => keysOf(dir, f)))).flat());
  const out: Record<string, string> = {};
  for (const { key, value } of parseEnv(text)) {
    if (key === "NODE_ENV" || shadowed.has(key) || value.includes("$")) continue;
    out[key] = value;
  }
  return out;
}
