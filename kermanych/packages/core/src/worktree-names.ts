import { homedir } from "os";
import { join } from "path";

// Cyrillic → Latin transliteration so a task written in Ukrainian (or Russian)
// still yields a readable branch slug instead of collapsing to "session".
// Ukrainian-first (г→h, и→y, і→i); applied after lowercasing, before the
// latin-only strip below.
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh",
  з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ъ: "", ы: "y", э: "e", ё: "e",
};

export function slugify(name: string): string {
  const latin = name.toLowerCase().replace(/[\u0400-\u04ff]/g, (ch) => TRANSLIT[ch] ?? "");
  return latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
}

// A short human label for a task, derived from the text that started it (a chat's
// first message, a transcript selection). First non-empty line, leading markdown
// decoration and inline emphasis stripped, capped so it reads as a label. Empty
// text yields "" so the caller can fall back to a name of its own.
export function taskNameFromText(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const clean = firstLine.replace(/^[#>\-*\d.)\s]+/, "").replace(/[*_`]/g, "").trim();
  return (clean || firstLine).slice(0, 60);
}
export const BRANCH_PREFIXES = ["feature", "fix", "refactoring", "chore"] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

export function branchName(slug: string, prefix: BranchPrefix = "feature"): string {
  return `${prefix}/${slug}`;
}
export function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let n = 2; while (existing.has(`${base}-${n}`)) n++; return `${base}-${n}`;
}
export function worktreeDir(sessionId: string): string {
  return join(homedir(), ".kermanych", "worktrees", sessionId);
}
