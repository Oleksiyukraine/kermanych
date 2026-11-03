// «Дизайн» (docs/specs/2026-10-29-design-tab.md): a design is an agent session stamped with
// `designDir`, run by the «Дизайнер» role on a `design/<slug>` branch. It builds the screen as a
// prototype on the project's own UI kit with fixtures, and keeps a folder under `docs/design/`
// with the README and the screenshots that people and implementing agents read.

import { DESIGN_README, DOCS_LAYOUT } from "./doc-policy";

// The roles (DESIGNER_AGENT_ID, DESIGN_SAVE_AGENT_ID) live in agents.ts with the other roles;
// the skills (DESIGN_SPEC_SKILL, IMPLEMENT_FROM_DESIGN_SKILL) in doc-policy.ts beside the other
// documentation skills, because the gate and the policy line name them.

// Screenshots are `<screen>-<state>@<width>.png` under the folder's `screens/`.
export const DESIGN_SCREENS_DIR = "screens";
export const DESIGN_WIDTHS = [390, 1280] as const;

// The folder of a design launched on `day` (YYYY-MM-DD) whose branch slug is `slug`:
// `docs/design/2026-10-29-orders-list`.
export function designDirFor(day: string, slug: string): string {
  return `${DOCS_LAYOUT.design}/${day}-${slug}`;
}

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

// The commit message «Зберегти дизайн» asks for.
export function designCommitMessage(topic: string): string {
  return `design: ${topic}`;
}
