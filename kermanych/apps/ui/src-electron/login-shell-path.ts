import { execFile } from 'node:child_process';

// A packaged app started from Finder, the Dock or a Linux desktop launcher inherits the
// session's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin` from launchd on macOS) — no Homebrew,
// bun, nvm or ~/.local/bin. The api spawns `omp`, `claude` and `git` by bare name, so without
// this every session fails with ENOENT. Run the user's login + interactive shell once (the
// profile and rc files are where those directories join PATH) and adopt its PATH before the
// api boots: every later spawn then finds what the user's terminal finds.
// Spec: docs/specs/2026-10-12-desktop-releases-and-updates.md, decision 5.

const MARK = '__KERMANYCH_ENV__';
const TIMEOUT_MS = 5000;

export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const { promise, resolve } = Promise.withResolvers<string>();
  // `/usr/bin/env` instead of `echo $PATH`: the same command line works in sh, bash, zsh and
  // fish (fish's PATH is a list, `env` prints it in the exported `a:b` form). The markers cut
  // away whatever the rc files print themselves (banners, `fortune`, motd).
  const child = execFile(
    shell,
    ['-ilc', `echo ${MARK}; /usr/bin/env; echo ${MARK}`],
    { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    // A broken rc file exits non-zero but may still have printed the environment.
    (_err, stdout) => resolve(stdout ?? ''),
  );
  // An interactive shell must not wait on (or grab) a terminal it does not have.
  child.stdin?.end();
  const out = await promise;
  const [, block] = out.split(MARK);
  const line = block?.split('\n').find((l) => l.startsWith('PATH='));
  const path = line?.slice('PATH='.length).trim();
  if (path) process.env.PATH = path;
  else console.warn(`[kermanych] login shell ${shell} gave no PATH; keeping ${process.env.PATH ?? ''}`);
}
