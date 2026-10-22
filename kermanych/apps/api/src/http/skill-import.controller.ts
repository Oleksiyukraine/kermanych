// The «Навички» import picker's reads (spec: docs/specs/2026-10-22-skill-import.md). The UI
// runs in a browser and cannot read this machine's skill folders; this local API can. Reads
// only: the picked skill is written to the library by the UI, straight to Supabase, like any
// other library row. Behind the global auth guard, like `GET /fs/list`.
import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { resolve } from "node:path";
import type { SkillImportRead, SkillImportRoot, SkillImportScan } from "@kermanych/core";
import { hasSkillFile, homeSkillRoots, readSkillDir, scanSkillFolder } from "../skills/skill-files";

@Controller("skills/import")
export class SkillImportController {
  // The standard home-directory roots that exist here, each with the skills one level down.
  @Get("roots")
  async roots(): Promise<SkillImportRoot[]> {
    return await homeSkillRoots();
  }

  // A folder chosen with «Інша тека…»: one skill, a root of several, or none.
  @Get("scan")
  async scan(@Query("path") path?: string): Promise<SkillImportScan> {
    if (!path?.trim()) throw new BadRequestException("path is required");
    try {
      return await scanSkillFolder(resolve(path));
    } catch (err) {
      throw new BadRequestException(`cannot read folder: ${(err as Error).message}`);
    }
  }

  // The picked skill with its body. Reads `<dir>/SKILL.md` and nothing else: the skill's other
  // files are listed by name only.
  @Get("read")
  async read(@Query("dir") dir?: string): Promise<SkillImportRead> {
    if (!dir?.trim()) throw new BadRequestException("dir is required");
    const abs = resolve(dir);
    if (!(await hasSkillFile(abs))) throw new BadRequestException(`no SKILL.md in ${abs}`);
    try {
      return await readSkillDir(abs);
    } catch (err) {
      throw new BadRequestException(`cannot read skill: ${(err as Error).message}`);
    }
  }
}
