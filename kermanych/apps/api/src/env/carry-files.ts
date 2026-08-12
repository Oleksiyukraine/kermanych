// apps/api/src/env/carry-files.ts
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

// Copy each declared file that exists in projectDir into wtDir at the same
// relative path. Missing entries are skipped (a project may not have `.env`).
export async function copyCarryFiles(projectDir: string, wtDir: string, files: string[]): Promise<void> {
  const base = resolve(projectDir);
  for (const f of files) {
    const src = resolve(base, f);
    if (!src.startsWith(base + sep)) continue; // skip .. / absolute escapes
    if (!existsSync(src)) continue;
    const dest = join(wtDir, f);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}
