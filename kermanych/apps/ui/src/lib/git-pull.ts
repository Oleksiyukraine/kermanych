// One line out of `git pull --ff-only`'s output for the footer Pull toast. The api returns
// git's stdout and stderr verbatim (WorktreeService.pull): a fast-forward brings a diffstat
// with a line per changed file, a refusal brings a block of `hint:` lines — dumped into a
// toast, either stretches it to the height of the window. The toast only has to say what
// happened, so it gets the one line that does:
//   1. the first `fatal:` / `error:` line, prefix dropped — why git refused;
//   2. the diffstat total («3 files changed, 10 insertions(+), 2 deletions(-)»);
//   3. otherwise the last non-empty line («Already up to date.»).
// '' for an empty output: the caller owns the fallback wording.
export function pullSummary(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const failure = lines.find((l) => /^(fatal|error):/i.test(l));
  if (failure) return failure.replace(/^(fatal|error):\s*/i, '');
  const stat = lines.find((l) => /^\d+ files? changed\b/.test(l));
  if (stat) return stat;
  return lines.at(-1) ?? '';
}
