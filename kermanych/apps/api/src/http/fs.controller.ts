// apps/api/src/http/fs.controller.ts
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { DirListing } from "@kermanych/core";

// Server-side directory browser. The UI runs in a browser and cannot read
// absolute filesystem paths, but this local API can — so the New-Project picker
// navigates the real filesystem here and returns an absolute path. Lists
// sub-directories of `path` (defaults to home); hidden dirs are skipped and git
// repos are flagged so the user can spot valid project roots.
@Controller("fs")
export class FsController {
  @Get("list")
  async list(@Query("path") path?: string): Promise<DirListing> {
    const dir = resolve(path && path.trim() ? path : homedir());
    try {
      const ents = await readdir(dir, { withFileTypes: true });
      const entries = ents
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, isRepo: existsSync(join(dir, e.name, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = parse(dir).root === dir ? null : dirname(dir);
      return { path: dir, parent, entries };
    } catch (err) {
      throw new BadRequestException(`cannot read directory: ${(err as Error).message}`);
    }
  }
}
