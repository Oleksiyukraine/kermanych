// Two-letter stand-in for a name on a square tile. The left rail has two of them — a
// project tile (KRailItem) and the account tile at its foot (KUserButton) — and they must
// derive the letters the same way, so this is the one place that does it.
//
// Splits on the separators names actually arrive with: spaces for a display name
// («Олексій Моторний» → ОМ), slashes/dashes/underscores for a repo or a GitHub handle
// (`kermanych/ui` → KU, `oleksii-motornyi` → OM). A single word gives its first two
// characters. `fallback` is what an empty name renders as; each caller owns its own glyph,
// because a project tile and an account tile do not admit emptiness with the same mark.
export function initialsOf(name: string, fallback: string): string {
  const words = name.trim().split(/[\s/_-]+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return fallback;
  if (!second) return first.slice(0, 2).toUpperCase();
  return ((first[0] ?? '') + (second[0] ?? '')).toUpperCase();
}
