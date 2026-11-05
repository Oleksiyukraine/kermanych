// apps/api/src/http/fs.controller.ts
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { DirListing } from "@kermanych/core";

// Server-side directory browser. The UI runs in a browser and cannot read
// absolute filesystem paths, but this local API can — so the New-Project picker
// navigates the real filesystem here and returns an absolute path. Lists
// sub-directories of `path` (defaults to home) and flags git repos so the user can spot
// valid project roots. Hidden dirs are skipped unless `hidden=1`: the skill import picker
// needs `~/.claude`, `~/.agents` and friends, and in that mode each entry also says whether it
// holds a SKILL.md. Symlinked folders count as folders in that mode, because a linked-in skill
// is the common way a shared one lands in a skills root.
@Controller("fs")
export class FsController {
  @Get("list")
  async list(@Query("path") path?: string, @Query("hidden") hidden?: string): Promise<DirListing> {
    const dir = resolve(path && path.trim() ? path : homedir());
    const skills = hidden === "1";
    try {
      const ents = await readdir(dir, { withFileTypes: true });
      const entries = ents
        .filter((e) => (skills ? e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name))) : e.isDirectory()))
        .filter((e) => skills || !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isRepo: existsSync(join(dir, e.name, ".git")),
          ...(skills ? { hasSkill: isFile(join(dir, e.name, "SKILL.md")) } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = parse(dir).root === dir ? null : dirname(dir);
      return { path: dir, parent, entries };
    } catch (err) {
      throw new BadRequestException(`cannot read directory: ${(err as Error).message}`);
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
