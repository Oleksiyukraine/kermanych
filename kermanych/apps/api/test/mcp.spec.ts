// «ШІ-команда → MCP-сервери» (docs/specs/2026-11-14-project-mcp-servers.md) over temp checkouts.
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { McpServerDef } from "@kermanych/core";
import { McpError, McpService } from "../src/mcp/mcp.service";
import { mcpLaunchEnv, replaceCodexTableText } from "../src/mcp/mcp-files";
import { checkMcpServer } from "../src/mcp/mcp-check";
import { EnvFileService } from "../src/env/env-file.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { RegistryService } from "../src/registry/registry.service";
import { RpcSession } from "../src/rpc/rpc-session";

let dir: string;
let repo: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kmq-mcp-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, text: string, base = repo): void {
  mkdirSync(join(base, rel, ".."), { recursive: true });
  writeFileSync(join(base, rel), text);
}
const read = (rel: string, base = repo) => readFileSync(join(base, rel), "utf8");

function service(localRepoPath = repo): McpService {
  const worktree = new WorktreeService();
  const registry = { listProjects: () => [{ id: "p1", localRepoPath }] } as unknown as RegistryService;
  return new McpService(registry, new EnvFileService(worktree), worktree);
}

const DEV_DB = { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${DEV_DB_RO_URL_KMQ}"] };
const NEXT_DOCS = { command: "npx", args: ["-y", "@andygo.dev/nextjs-harness", "mcp", "start"] };

test("view merges one server across files, names its harnesses, and reports variables", async () => {
  write(".mcp.json", JSON.stringify({ mcpServers: { "nextjs-docs": NEXT_DOCS, "dev-db": DEV_DB } }));
  write(".codex/config.toml", `[mcp_servers.nextjs-docs]\ncommand = "npx"\nargs = ["-y", "@andygo.dev/nextjs-harness", "mcp", "start"]\n`);
  write(".cursor/mcp.json", JSON.stringify({ mcpServers: { cursor_only: { url: "https://x/mcp" } } }));
  const view = await service().view("p1");
  const by = Object.fromEntries(view.servers.map((s) => [s.name, s]));
  expect(by["nextjs-docs"]).toMatchObject({ files: [".mcp.json", ".codex/config.toml"], seenBy: ["omp", "claude", "codex"], editable: true, codex: { state: "mirrored" } });
  expect(by["dev-db"]).toMatchObject({ seenBy: ["omp", "claude"], codex: { state: "gap", gap: "args" }, vars: [{ name: "DEV_DB_RO_URL_KMQ", optional: false, state: "unset" }] });
  expect(by["cursor_only"]).toMatchObject({ seenBy: ["omp"], editable: false });
  expect(by["cursor_only"]!.codex).toBeUndefined();
  expect(view.uncommitted).toEqual([".mcp.json", ".codex/config.toml"]);

  write(".env", "DEV_DB_RO_URL_KMQ=postgres://ro@db/app\n");
  const again = await service().view("p1");
  expect(again.servers.find((s) => s.name === "dev-db")!.vars[0]!.state).toBe("env-file");
});

test("a secret header goes to .env, the placeholder to .mcp.json, the mapped table to codex", async () => {
  const def: McpServerDef = { kind: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_AUTHORIZATION}" } };
  await service().save("p1", "linear", { def, secrets: { LINEAR_AUTHORIZATION: "lin_api_123" } }, true);
  expect(JSON.parse(read(".mcp.json"))).toEqual({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_AUTHORIZATION}" } } } });
  expect(read(".env")).toContain("LINEAR_AUTHORIZATION=lin_api_123");
  expect(read(".codex/config.toml")).toBe(`[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\nbearer_token_env_var = "LINEAR_AUTHORIZATION"\n`);
  await expect(service().save("p1", "linear", { def }, true)).rejects.toThrow(/already in .mcp.json/);
});

test("an update keeps the server's unknown keys, the file's indentation and other servers", async () => {
  write(".mcp.json", `{\n    "$schema": "x",\n    "mcpServers": {\n        "a": { "command": "old", "timeout": 5000 },\n        "b": { "command": "b" }\n    }\n}\n`);
  await service().save("p1", "a", { def: { kind: "stdio", command: "new", args: ["x"], env: { MODE: "ro" } } }, false);
  const text = read(".mcp.json");
  expect(text).toMatch(/^\{\n {4}"\$schema"/);
  expect(JSON.parse(text)).toEqual({ $schema: "x", mcpServers: { a: { type: "stdio", command: "new", args: ["x"], env: { MODE: "ro" }, timeout: 5000 }, b: { command: "b" } } });
});

test("codex table replacement leaves the rest of the file byte for byte and keeps unmanaged keys", () => {
  const head = `# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.other] # keep\ncommand = "o"\n\n`;
  const server = `[mcp_servers.x]\ncommand = "old"\nstartup_timeout_sec = 20\n\n[mcp_servers.x.env]\nA = "1"\n\n[mcp_servers.x.tools.open]\napproval = "auto"\n`;
  const tail = `\n[profiles.fast]\nmodel = "mini"\n`;
  const out = replaceCodexTableText(head + server + tail, "x", { command: "new", env_vars: ["K"] });
  expect(out.startsWith(head)).toBe(true);
  expect(out.endsWith(tail)).toBe(true);
  expect(out).toContain('command = "new"');
  expect(out).toContain("startup_timeout_sec = 20");
  expect(out).toContain('[mcp_servers.x.tools.open]\napproval = "auto"');
  expect(out).not.toContain('A = "1"');

  expect(replaceCodexTableText(head + server + tail, "x", null)).toBe(head + tail);
});

test("an inline codex table is refused rather than rewritten", () => {
  expect(() => replaceCodexTableText(`[mcp_servers]\nx = { command = "a" }\n`, "x", { command: "b" })).toThrow(/inline/);
});

test("a hand-written codex table that differs is replaced only after confirmation", async () => {
  write(".codex/config.toml", `[mcp_servers.s]\ncommand = "hand"\n`);
  const body = { def: { kind: "stdio", command: "npx", args: ["s"], env: {} } as McpServerDef };
  const err = await service().save("p1", "s", body, true).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(McpError);
  expect((err as McpError).conflict).toEqual({ current: { command: "hand" }, next: { command: "npx", args: ["s"] } });
  expect(existsSync(join(repo, ".mcp.json"))).toBe(false);

  await service().save("p1", "s", { ...body, replaceCodex: true }, true);
  expect(read(".codex/config.toml")).toBe(`[mcp_servers.s]\ncommand = "npx"\nargs = [ "s" ]\n`);
});

test("delete removes the server from .mcp.json and codex", async () => {
  await service().save("p1", "s", { def: { kind: "stdio", command: "npx", args: [], env: {} } }, true);
  await service().remove("p1", "s");
  expect(JSON.parse(read(".mcp.json"))).toEqual({ mcpServers: {} });
  expect(read(".codex/config.toml")).not.toContain("mcp_servers.s");
});

test("a server of a bound subfolder moves to the root", async () => {
  const sub = join(repo, "app");
  write(".mcp.json", JSON.stringify({ mcpServers: { "project-docs": NEXT_DOCS } }), sub);
  const view = await service(sub).view("p1");
  expect(view.subdir).toBe("app");
  expect(view.servers).toMatchObject([{ name: "project-docs", location: "subdir", seenBy: [], editable: false }]);
  await service(sub).moveToRoot("p1", "project-docs", false);
  expect(JSON.parse(read(".mcp.json")).mcpServers["project-docs"]).toMatchObject(NEXT_DOCS);
  expect(JSON.parse(read("app/.mcp.json"))).toEqual({ mcpServers: {} });
});

test("mcpLaunchEnv hands over only the referenced .env keys", async () => {
  expect(mcpLaunchEnv(repo)).toEqual({});
  write(".mcp.json", JSON.stringify({ mcpServers: { "dev-db": DEV_DB } }));
  write(".codex/config.toml", `[mcp_servers.c]\ncommand = "c"\nenv_vars = ["CODEX_KEY"]\n`);
  write(".env", "DEV_DB_RO_URL_KMQ=pg://x\nCODEX_KEY=k\nSECRET_UNUSED=nope\n");
  expect(mcpLaunchEnv(repo)).toEqual({ DEV_DB_RO_URL_KMQ: "pg://x", CODEX_KEY: "k" });
  expect(mcpLaunchEnv(join(dir, "missing"))).toEqual({});
});

test("a managed omp launch gets the referenced variable from the folder's .env", async () => {
  write(".mcp.json", JSON.stringify({ mcpServers: { p: { command: "x", args: ["${KMQ_PROBE}"] } } }));
  write(".env", "KMQ_PROBE=from-dotenv\n");
  const out = join(dir, "env.txt");
  const omp = join(dir, "omp.mjs");
  writeFileSync(
    omp,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, process.env.KMQ_PROBE ?? "");\n` +
      `process.stdout.write(JSON.stringify({type:"ready",protocolVersion:2})+"\\n");\nsetInterval(()=>{},1000);\n`,
  );
  chmodSync(omp, 0o755);
  const rpc = new RpcSession({ cwd: repo, ompPath: omp });
  rpc.onExit(() => {});
  await rpc.start();
  await rpc.stop();
  expect(read("env.txt", dir)).toBe("from-dotenv");
});

const SERVER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn("sleep", ["30"], { stdio: "ignore" });
writeFileSync(process.env.PID_FILE, String(child.pid));
console.error("booting " + process.argv[2]);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    const result = m.method === "initialize" ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }
      : { tools: [{ name: "echo", description: "Echo it", inputSchema: { type: "object" } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});`;

test("«Перевірити» lists a stdio server's tools and stops its whole group", async () => {
  write("server.cjs", SERVER, dir);
  const pidFile = join(dir, "child.pid");
  const res = await checkMcpServer({ kind: "stdio", command: process.execPath, args: [join(dir, "server.cjs"), "arg"], env: { PID_FILE: pidFile } }, dir, { PATH: process.env.PATH ?? "" });
  expect(res).toMatchObject({ ok: true, tools: [{ name: "echo", description: "Echo it" }] });
  const pid = Number(readFileSync(pidFile, "utf8"));
  await sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("«Перевірити» reports a server that exits, with its stderr", async () => {
  const res = await checkMcpServer({ kind: "stdio", command: process.execPath, args: ["-e", "console.error('DATABASE_URL is required'); process.exit(1)"], env: {} }, dir, { PATH: process.env.PATH ?? "" });
  expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/exited/), stderr: ["DATABASE_URL is required"] });
});
