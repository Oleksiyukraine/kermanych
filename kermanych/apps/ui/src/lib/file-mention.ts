// apps/ui/src/lib/file-mention.ts
// A project file named in a task or a chat message as `@path/from/repo/root` — the convention
// omp and Claude Code both read as «this file». The text is all that travels: the agent works
// in the same tree (the session's worktree or the project checkout), so a repo-relative path is
// enough for it to open the file itself. These are the pure text rules; the picker and the
// textarea plumbing live in KFilePicker and useFileMention.

// Whether an `@` typed at `at` starts a mention: at the very start or right after whitespace.
// Mid-word it is an e-mail address or a handle, and the picker must not jump out at it.
export function opensMention(value: string, at: number): boolean {
  return at <= 0 || /\s/.test(value[at - 1] ?? '');
}

// A path with whitespace is quoted, or the token would end at its first space.
export function fileToken(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

// Lands the token for `path` in `value` at `at`. `replace`: the `@` at `at` is the one the
// operator typed to open the picker, so the token takes its place instead of doubling it. The
// token is kept apart from its neighbours by one space each side, never two, and `caret` is
// where typing continues — right after the token.
export function insertFileMention(
  value: string,
  at: number,
  path: string,
  replace: boolean,
): { value: string; caret: number } {
  const pos = Math.max(0, Math.min(at, value.length));
  const end = replace && value[pos] === '@' ? pos + 1 : pos;
  const before = value.slice(0, pos);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = /^\s/.test(after) ? '' : ' ';
  const head = `${before}${lead}${fileToken(path)}${trail}`;
  return { value: head + after, caret: head.length };
}
