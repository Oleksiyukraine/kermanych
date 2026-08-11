// apps/api/src/env/carry-files.ts
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Copy each declared file that exists in projectDir into wtDir at the same
// relative path. Missing entries are skipped (a project may not have `.env`).
export async function copyCarryFiles(projectDir: string, wtDir: string, files: string[]): Promise<void> {
  for (const f of files) {
    const src = join(projectDir, f);
    if (!existsSync(src)) continue;
    const dest = join(wtDir, f);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}
