// A markdown description as one line of plain text, for a card that has room for one line.
// A backlog card's description is often a finding's whole report («## Context … - [ ] …
// `path:line`»); printed raw, the markup is most of what fits. Headings are dropped (on a
// card they are only section names), list / checkbox / quote markers and code fences go,
// inline code, bold and links keep their text. Not a markdown parser: a preview that reads
// cleanly for the descriptions people and agents write, nothing more.
// Spec: docs/specs/2026-10-29-agent-list-cards.md, decision 2.
export function markdownPreview(md: string | undefined): string {
  if (!md) return '';
  const lines: string[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    // Headings, fence lines and horizontal rules carry no prose of their own.
    if (/^#{1,6}(\s|$)/.test(line) || /^(```|~~~)/.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) continue;
    lines.push(
      line
        .replace(/^(>\s?)+/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\[[ xX]\]\s+/, ''),
    );
  }
  return lines
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    // Paired emphasis only. `__` must not touch a word on its outer side, as in markdown
    // itself: `snake__case__name` is an identifier, not bold.
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
