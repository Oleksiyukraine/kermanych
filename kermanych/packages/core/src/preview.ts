// The live preview of a session (docs/specs/2026-11-03-session-browser-preview.md). The repository
// says how to run its app in `.kermanych/preview.json`, read from the session directory (the
// worktree, or the main checkout of an in-place session), so the commands travel with the branch
// whose code they build. Shared by the api, which runs it, and the ui, which shows its state.

export const PREVIEW_CONFIG_PATH = ".kermanych/preview.json";

// The step name of the optional `setup` command in the state and the logs. No service may take it.
export const PREVIEW_SETUP_STEP = "setup";

// A per-session temp directory Kermanych creates before `setup` and deletes with the session.
export const PREVIEW_DIR_VAR = "PREVIEW_DIR";

export type PreviewServiceDef = {
  name: string;
  command: string;
  // Raw values: `${VAR}` is expanded by expandPreviewEnv at start, when the ports are known.
  env: Record<string, string>;
  // The one service whose page the session browser opens.
  open: boolean;
};

export type PreviewConfig = { setup?: string; services: PreviewServiceDef[] };

export type PreviewConfigRead = { ok: true; config: PreviewConfig } | { ok: false; error: string };

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_REF_RE = /\$\{([^}]*)\}/g;
const TOP_KEYS: Record<string, true> = { setup: true, services: true };
const SERVICE_KEYS: Record<string, true> = { name: true, command: true, env: true, open: true };

// The variable that carries a service's port to every step: `web-app` → `PORT_WEB_APP`.
export function previewPortVar(service: string): string {
  return `PORT_${service.toUpperCase().replace(/-/g, "_")}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parse and validate the file's text. The error names the field (`services[1].command: …`), since
// it is shown to the operator in the preview row and handed to the agent to fix the file.
export function parsePreviewConfig(text: string): PreviewConfigRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, error: "the file must hold a JSON object" };
  for (const k of Object.keys(raw)) if (!Object.hasOwn(TOP_KEYS, k)) return { ok: false, error: `${k}: unknown field` };

  let setup: string | undefined;
  if (raw.setup !== undefined) {
    if (typeof raw.setup !== "string" || !raw.setup.trim()) return { ok: false, error: "setup: must be a non-empty string" };
    setup = raw.setup;
  }

  if (!Array.isArray(raw.services) || raw.services.length === 0) {
    return { ok: false, error: "services: must be a non-empty array" };
  }
  const services: PreviewServiceDef[] = [];
  const names = new Set<string>();
  for (const [i, s] of raw.services.entries()) {
    const at = `services[${i}]`;
    if (!isObject(s)) return { ok: false, error: `${at}: must be an object` };
    for (const k of Object.keys(s)) if (!Object.hasOwn(SERVICE_KEYS, k)) return { ok: false, error: `${at}.${k}: unknown field` };
    if (typeof s.name !== "string" || !SERVICE_NAME_RE.test(s.name)) {
      return { ok: false, error: `${at}.name: must match ${SERVICE_NAME_RE.source}` };
    }
    if (s.name === PREVIEW_SETUP_STEP) return { ok: false, error: `${at}.name: "${PREVIEW_SETUP_STEP}" is the setup step's name` };
    if (names.has(s.name)) return { ok: false, error: `${at}.name: "${s.name}" is used twice` };
    names.add(s.name);
    if (typeof s.command !== "string" || !s.command.trim()) return { ok: false, error: `${at}.command: must be a non-empty string` };
    const env: Record<string, string> = {};
    if (s.env !== undefined) {
      if (!isObject(s.env)) return { ok: false, error: `${at}.env: must be an object of strings` };
      for (const [k, v] of Object.entries(s.env)) {
        if (!ENV_KEY_RE.test(k)) return { ok: false, error: `${at}.env.${k}: not a valid variable name` };
        if (typeof v !== "string") return { ok: false, error: `${at}.env.${k}: must be a string` };
        env[k] = v;
      }
    }
    if (s.open !== undefined && typeof s.open !== "boolean") return { ok: false, error: `${at}.open: must be true or false` };
    services.push({ name: s.name, command: s.command, env, open: s.open === true });
  }

  const open = services.filter((s) => s.open);
  if (open.length !== 1) {
    return { ok: false, error: `services: exactly one service needs "open": true (found ${open.length})` };
  }

  // Kermanych's variables are the only ones `${…}` expands, and they are reserved: a service that
  // set PORT itself would point the readiness check at the wrong port.
  const known = new Set(["PORT", PREVIEW_DIR_VAR, ...services.map((s) => previewPortVar(s.name))]);
  for (const [i, s] of services.entries()) {
    for (const [k, v] of Object.entries(s.env)) {
      if (known.has(k)) return { ok: false, error: `services[${i}].env.${k}: set by Kermanych, cannot be overridden` };
      for (const m of v.matchAll(VAR_REF_RE)) {
        if (!known.has(m[1]!)) {
          return { ok: false, error: `services[${i}].env.${k}: unknown variable \${${m[1]}} (known: ${[...known].join(", ")})` };
        }
      }
    }
  }
  return { ok: true, config: setup === undefined ? { services } : { setup, services } };
}

// Expand `${VAR}` in one env value. parsePreviewConfig has already refused unknown names.
export function expandPreviewEnv(value: string, vars: Record<string, string>): string {
  return value.replace(VAR_REF_RE, (whole, name: string) => vars[name] ?? whole);
}

export type PreviewPort = { name: string; port: number };

// Owned by the api (PreviewService), pushed to the ui on every change. `null` (no entry) means the
// preview has not been started since the api started.
export type PreviewState =
  // `step` is `setup` or the service being waited for.
  | { phase: "starting"; step: string; services: PreviewPort[] }
  | { phase: "running"; url: string; services: PreviewPort[] }
  | { phase: "stopped" }
  // A step exited after the preview was running; the others were stopped with it.
  | { phase: "crashed"; step: string; code: number | null; signal: string | null }
  // The start did not get to running: a step exited, timed out, or could not be spawned.
  | { phase: "failed"; step: string; error: string };

export type PreviewConfigStatus = { kind: "ok"; services: string[] } | { kind: "missing" } | { kind: "invalid"; error: string };

// GET /sessions/:id/preview.
export type PreviewInfo = { state: PreviewState | null; config: PreviewConfigStatus };

// GET /sessions/:id/preview/logs?step=&since=. `seq` grows for the life of the api, `run` counts
// starts: a client whose `run` changed clears what it shows. `steps` lists the steps of this run
// that have a log, in start order.
export type PreviewLogLine = { seq: number; text: string };
export type PreviewLogs = { run: number; steps: string[]; lines: PreviewLogLine[]; next: number };
