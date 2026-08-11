// apps/api/src/env/env-file.service.ts
import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { EnvFileView } from "@kermanych/core";
import { WorktreeService } from "../worktree/worktree.service";
import { parseEnv, applyEnvEdits } from "./env-text";

@Injectable()
export class EnvFileService {
  constructor(private worktree: WorktreeService) {}

  // Resolve `<projectDir>/<file>` and refuse anything that escapes projectDir.
  private target(projectDir: string, file: string): string {
    const base = resolve(projectDir);
    const target = resolve(projectDir, file);
    if (!target.startsWith(base + sep)) throw new Error(`path escapes project directory: ${file}`);
    return target;
  }

  async read(projectDir: string, file = ".env"): Promise<EnvFileView> {
    const target = this.target(projectDir, file);
    const text = existsSync(target) ? await readFile(target, "utf8") : "";
    const ignored = await this.worktree.isIgnored(projectDir, file);
    return { entries: parseEnv(text), ignored };
  }

  async write(
    projectDir: string,
    file = ".env",
    edits: { set?: Record<string, string>; remove?: string[] },
  ): Promise<EnvFileView> {
    const target = this.target(projectDir, file);
    const current = existsSync(target) ? await readFile(target, "utf8") : "";
    const next = applyEnvEdits(current, edits);
    const tmp = `${target}.kmq-${process.pid}.tmp`;
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, target); // atomic on the same filesystem
    return this.read(projectDir, file);
  }
}
