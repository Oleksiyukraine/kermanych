// apps/api/src/mcp/mcp.service.ts
// «ШІ-команда → MCP-сервери» (docs/specs/2026-11-14-project-mcp-servers.md). The repository
// files are the only copy: this reads them at the checkout's git root (where every session's
// harness starts), merges them by server name, and writes `.mcp.json` with its codex mirror.
// Nothing is committed and nothing goes to the cloud.
import { Injectable } from "@nestjs/common";
import { relative } from "node:path";
import {
  MCP_CODEX_FILE,
  MCP_FILES,
  MCP_JSON_FILE,
  MCP_NAME_RE,
  MCP_VAR_NAME_RE,
  codexKnown,
  codexTablesEqual,
  expandMcpDef,
  mcpSeenBy,
  mcpToCodex,
  mcpVarRefs,
  type McpCheckResult,
  type McpCodexConflict,
  type McpCodexState,
  type McpFile,
  type McpFileError,
  type McpProjectView,
  type McpSaveBody,
  type McpServerDef,
  type McpServerRow,
} from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { EnvFileService } from "../env/env-file.service";
import { WorktreeService } from "../worktree/worktree.service";
import { checkMcpServer } from "./mcp-check";
import { findGitRoot, readCodexTable, readDotenv, readMcpFile, removeServer, writeCodexTable, writeJsonServer, type McpFileServer } from "./mcp-files";

/** A refusal the controller turns into 400, or 409 with the codex tables to compare. */
export class McpError extends Error {
  constructor(message: string, readonly conflict?: McpCodexConflict) {
    super(message);
  }
}

type Place = { repo: string; root: string; subdir: string };
type Found = { dir: string; files: Map<McpFile, McpFileServer> };

@Injectable()
export class McpService {
  constructor(
    private registry: RegistryService,
    private env: EnvFileService,
    private worktree: WorktreeService,
  ) {}

  private place(projectId: string): Place {
    const p = this.registry.listProjects().find((x) => x.id === projectId);
    if (!p) throw new McpError("project not found");
    if (!p.localRepoPath) throw new McpError("project not bound");
    const root = findGitRoot(p.localRepoPath) ?? p.localRepoPath;
    return { repo: p.localRepoPath, root, subdir: relative(root, p.localRepoPath) };
  }

  // Every server of one folder, by name, with the file each definition came from.
  private async scan(dir: string, errors: McpFileError[], prefix: string): Promise<Map<string, Found>> {
    const byName = new Map<string, Found>();
    for (const file of MCP_FILES) {
      const read = readMcpFile(dir, file);
      if (!read) continue;
      if ("error" in read) {
        errors.push({ file: prefix + file, error: read.error });
        continue;
      }
      for (const [name, server] of read.servers) {
        const found = byName.get(name) ?? { dir, files: new Map() };
        found.files.set(file, server);
        byName.set(name, found);
      }
    }
    return byName;
  }

  private codexState(def: McpServerDef, files: Map<McpFile, McpFileServer>): McpCodexState {
    const mapped = mcpToCodex(def);
    if ("gap" in mapped) return { state: "gap", gap: mapped.gap };
    const current = files.get(MCP_CODEX_FILE);
    if (!current) return { state: "missing" };
    return { state: codexTablesEqual(codexKnown(current.raw), mapped.table) ? "mirrored" : "differs" };
  }

  async view(projectId: string): Promise<McpProjectView> {
    const { repo, root, subdir } = this.place(projectId);
    const errors: McpFileError[] = [];
    const dotenv = readDotenv(repo);
    const rows = (found: Map<string, Found>, location: McpServerRow["location"]): McpServerRow[] =>
      [...found].map(([name, { files }]) => {
        const def = (files.get(MCP_JSON_FILE) ?? files.values().next().value!).def;
        const editable = location === "root" && files.has(MCP_JSON_FILE);
        return {
          name,
          def,
          files: [...files.keys()],
          location,
          editable,
          seenBy: location === "root" ? mcpSeenBy([...files.keys()]) : [],
          ...(editable ? { codex: this.codexState(def, files) } : {}),
          vars: mcpVarRefs(def).map((v) => ({
            ...v,
            state: dotenv[v.name] ? "env-file" : process.env[v.name] ? "process" : "unset",
          })),
        };
      });
    const servers = rows(await this.scan(root, errors, ""), "root");
    if (subdir) servers.push(...rows(await this.scan(repo, errors, `${subdir}/`), "subdir"));

    // `git status` lists an untracked folder as `.codex/`, not the file inside it.
    const changed = await this.worktree.uncommittedFiles(root).catch(() => [] as string[]);
    const uncommitted = [MCP_JSON_FILE, MCP_CODEX_FILE].filter((f) => changed.some((c) => c === f || (c.endsWith("/") && f.startsWith(c))));
    const envIgnored = await this.worktree.isIgnored(repo, ".env");
    return { root, subdir, servers, uncommitted, envIgnored, errors };
  }

  private validate(name: string, body: McpSaveBody): void {
    if (!MCP_NAME_RE.test(name)) throw new McpError("the name may hold only letters, digits, «-» and «_», up to 64 characters");
    const def = body?.def;
    const ok =
      def?.kind === "stdio"
        ? typeof def.command === "string" && def.command.trim() !== "" && Array.isArray(def.args) && def.args.every((a) => typeof a === "string") && isStringMap(def.env)
        : def?.kind === "http" && typeof def.url === "string" && def.url.trim() !== "" && isStringMap(def.headers);
    if (!ok) throw new McpError("the server needs a command, or a URL");
    for (const key of Object.keys(body.secrets ?? {})) if (!MCP_VAR_NAME_RE.test(key)) throw new McpError(`not a variable name: ${key}`);
  }

  // `.mcp.json` first, then the codex mirror: a server with no codex form leaves codex's table,
  // if a hand-written one exists, alone. A different hand-written table is replaced only after
  // the operator saw both (`replaceCodex`).
  private async writeServer(root: string, name: string, def: McpServerDef, replaceCodex: boolean): Promise<void> {
    const mapped = mcpToCodex(def);
    if ("table" in mapped) {
      const current = await readCodexTable(root, name);
      if (current && !replaceCodex && !codexTablesEqual(codexKnown(current), mapped.table)) {
        throw new McpError(`${MCP_CODEX_FILE} already has a different «${name}»`, { current: codexKnown(current), next: mapped.table });
      }
    }
    await writeJsonServer(root, MCP_JSON_FILE, name, def);
    if ("table" in mapped) await writeCodexTable(root, name, mapped.table);
  }

  private async rootServers(root: string): Promise<Map<string, McpFileServer>> {
    const read = readMcpFile(root, MCP_JSON_FILE);
    if (read && "error" in read) throw new McpError(`${MCP_JSON_FILE} does not parse: ${read.error}`);
    return read?.servers ?? new Map();
  }

  /** «Додати» (`create`) and «Змінити». The secrets go to the project's `.env` before the files change. */
  async save(projectId: string, name: string, body: McpSaveBody, create: boolean): Promise<McpProjectView> {
    this.validate(name, body);
    const { repo, root } = this.place(projectId);
    const exists = (await this.rootServers(root)).has(name);
    if (create && exists) throw new McpError(`«${name}» is already in ${MCP_JSON_FILE}`);
    if (!create && !exists) throw new McpError(`«${name}» is not in ${MCP_JSON_FILE}`);
    if (body.secrets && Object.keys(body.secrets).length) await this.env.write(repo, ".env", { set: body.secrets });
    await this.writeServer(root, name, body.def, !!body.replaceCodex);
    return this.view(projectId);
  }

  /**
   * «Видалити»: from the root `.mcp.json` and its codex mirror; at `subdir`, from every MCP file
   * of the bound subfolder (a copy sessions never saw, often a stale duplicate of a root server).
   */
  async remove(projectId: string, name: string, location: McpServerRow["location"] = "root"): Promise<McpProjectView> {
    if (location === "subdir") {
      const { place, found } = await this.found(projectId, name, "subdir");
      for (const file of found.files.keys()) await removeServer(place.repo, file, name);
      return this.view(projectId);
    }
    const { root } = this.place(projectId);
    if (!(await this.rootServers(root)).has(name)) throw new McpError(`«${name}» is not in ${MCP_JSON_FILE}`);
    await writeJsonServer(root, MCP_JSON_FILE, name, null);
    await writeCodexTable(root, name, null);
    return this.view(projectId);
  }

  private async found(projectId: string, name: string, location: McpServerRow["location"]): Promise<{ place: Place; found: Found }> {
    const place = this.place(projectId);
    const dir = location === "root" ? place.root : place.repo;
    const found = (await this.scan(dir, [], "")).get(name);
    if (!found || (location === "subdir" && !place.subdir)) throw new McpError(`no server «${name}»`);
    return { place, found };
  }

  /** «Скопіювати в .mcp.json»: a server defined only in another root file. That file is left as it is. */
  async copyToMcpJson(projectId: string, name: string, replaceCodex: boolean): Promise<McpProjectView> {
    const { place, found } = await this.found(projectId, name, "root");
    if (found.files.has(MCP_JSON_FILE)) throw new McpError(`«${name}» is already in ${MCP_JSON_FILE}`);
    await this.writeServer(place.root, name, found.files.values().next().value!.def, replaceCodex);
    return this.view(projectId);
  }

  /** «Перенести в корінь»: from the bound subfolder's files into the root `.mcp.json`. */
  async moveToRoot(projectId: string, name: string, replaceCodex: boolean): Promise<McpProjectView> {
    const { place, found } = await this.found(projectId, name, "subdir");
    if ((await this.rootServers(place.root)).has(name)) throw new McpError(`«${name}» is already in ${MCP_JSON_FILE} at the repository root`);
    const def = (found.files.get(MCP_JSON_FILE) ?? found.files.values().next().value!).def;
    await this.writeServer(place.root, name, def, replaceCodex);
    for (const file of found.files.keys()) await removeServer(place.repo, file, name);
    return this.view(projectId);
  }

  /** «Перевірити»: in the git root, with the api's environment plus the project's `.env`. */
  async check(projectId: string, name: string, location: McpServerRow["location"]): Promise<McpCheckResult> {
    const { place, found } = await this.found(projectId, name, location);
    const def = (found.files.get(MCP_JSON_FILE) ?? found.files.values().next().value!).def;
    const env = { ...process.env, ...readDotenv(place.repo) } as Record<string, string>;
    return checkMcpServer(expandMcpDef(def, env), found.dir, env);
  }
}

function isStringMap(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}
