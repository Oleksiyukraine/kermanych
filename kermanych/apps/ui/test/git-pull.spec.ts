import { describe, expect, it } from 'vitest';
import { pullSummary } from '../src/lib/git-pull';

// The footer Pull toast shows one line of `git pull --ff-only` output: the whole diffstat or
// hint block stretched the toast to the height of the window.
describe('pullSummary', () => {
  it('reduces a fast-forward to the diffstat total, not the per-file lines', () => {
    const out = [
      'From github.com:acme/app',
      '   1a2b3c4..5d6e7f8  dev        -> origin/dev',
      'Updating 1a2b3c4..5d6e7f8',
      'Fast-forward',
      ' apps/ui/src/components/kit/KToast.vue | 12 +++++++++---',
      ' apps/ui/src/lib/git-pull.ts           | 20 ++++++++++++++++++++',
      ' 2 files changed, 29 insertions(+), 3 deletions(-)',
      ' create mode 100644 apps/ui/src/lib/git-pull.ts',
      '',
    ].join('\n');
    expect(pullSummary(out)).toBe('2 files changed, 29 insertions(+), 3 deletions(-)');
  });

  it('keeps the singular diffstat total', () => {
    expect(pullSummary('Fast-forward\n README.md | 1 +\n 1 file changed, 1 insertion(+)\n')).toBe(
      '1 file changed, 1 insertion(+)',
    );
  });

  it('reduces a refusal to the reason, without the hints or the prefix', () => {
    const out = [
      "hint: Diverging branches can't be fast-forwarded, you need to either:",
      'hint:',
      'hint: \tgit merge --no-ff',
      'hint:',
      'hint: or:',
      'hint:',
      'hint: \tgit rebase',
      'fatal: Not possible to fast-forward, aborting.',
      '',
    ].join('\n');
    expect(pullSummary(out)).toBe('Not possible to fast-forward, aborting.');
  });

  it('takes the first error line over the file list that follows it', () => {
    const out = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tdocs/a.md',
      '\tdocs/b.md',
      'Please move or remove them before you merge.',
      'Aborting',
    ].join('\n');
    expect(pullSummary(out)).toBe('The following untracked working tree files would be overwritten by merge:');
  });

  it('falls back to the last line, and to empty for no output', () => {
    expect(pullSummary('Already up to date.\n')).toBe('Already up to date.');
    expect(pullSummary('  \n')).toBe('');
  });
});
