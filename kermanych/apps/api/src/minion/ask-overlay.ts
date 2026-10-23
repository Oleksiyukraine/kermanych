// apps/api/src/minion/ask-overlay.ts
// «Посіпака» runs with nobody to answer (docs/specs/2026-10-23-minion-auto-run.md, decision 9):
// omp gets one more `--config` overlay that turns its ask tool off. The text never varies, so
// the file is written once per process and shared by every minion child; it lives beside the
// skills and resources overlays, under the same test override.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NO_ASK_OVERLAY = "ask:\n  enabled: false\n";

// Path → the write in flight or done. Keyed by path because a spec may move the home between runs.
const written = new Map<string, Promise<string | undefined>>();

// The overlay's path, or undefined when it could not be written. Never throws, like the other
// overlays: the run then keeps its ask tool, and the time cap still ends a run that waits on it.
export function noAskOverlay(): Promise<string | undefined> {
  const dir = join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "minion");
  const path = join(dir, "no-ask.config.yml");
  let p = written.get(path);
  if (!p) {
    p = mkdir(dir, { recursive: true })
      .then(() => writeFile(path, NO_ASK_OVERLAY, "utf8"))
      .then(
        () => path,
        (err: unknown) => {
          console.warn(`[minion] the no-ask overlay was not written: ${(err as Error).message}`);
          // Forgotten, so the next spawn tries again.
          written.delete(path);
          return undefined;
        },
      );
    written.set(path, p);
  }
  return p;
}
