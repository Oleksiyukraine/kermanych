// Design folders under `docs/design/` (docs/specs/2026-10-29-design-tab.md): one folder per
// screen, written by a session that follows the `design-spec` skill, with the README and the
// screenshots that people and implementing agents read. The «Дизайн» tab that once wrote them is
// gone (docs/specs/2026-11-09-merge-design-into-synergy.md); the folders, the docs policy kind and
// «Задача з документа» on a design README stay.

import { DESIGN_README, DOCS_LAYOUT } from "./doc-policy";

// The skills `design-spec` (skills.ts) and IMPLEMENT_FROM_DESIGN_SKILL (doc-policy.ts, because the
// policy line names it) carry the method.

// Screenshots are `<screen>-<state>@<width>.png` under the folder's `screens/`.
export const DESIGN_SCREENS_DIR = "screens";

// The README of a design folder, repository-relative.
export function designReadmePath(designDir: string): string {
  return `${designDir}/${DESIGN_README}`;
}

// The design folder a repository-relative path belongs to, judged by the `docs/design/<folder>/`
// prefix: `docs/design/2026-10-29-orders/screens/list-empty@390.png` → `docs/design/2026-10-29-orders`.
// Undefined for anything else, including a file directly under `docs/design/`.
export function designDirOf(path: string): string | undefined {
  const prefix = `${DOCS_LAYOUT.design}/`;
  if (!path.startsWith(prefix)) return undefined;
  const folder = path.slice(prefix.length).split("/")[0];
  return folder && path.length > prefix.length + folder.length + 1 ? `${prefix}${folder}` : undefined;
}

// The screenshots of a design folder among repository-relative paths, widest first then by
// name, so a card gets the desktop view before the phone one.
export function designScreenshots(designDir: string, paths: readonly string[]): string[] {
  const dir = `${designDir}/${DESIGN_SCREENS_DIR}/`;
  const width = (p: string) => Number(/@(\d+)\.png$/i.exec(p)?.[1] ?? 0);
  return paths
    .filter((p) => p.startsWith(dir) && /\.png$/i.test(p) && !p.slice(dir.length).includes("/"))
    .sort((a, b) => width(b) - width(a) || a.localeCompare(b));
}
