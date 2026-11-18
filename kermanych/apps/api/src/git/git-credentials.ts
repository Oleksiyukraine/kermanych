// apps/api/src/git/git-credentials.ts
// The environment every git call that talks to a remote on the api's own behalf runs with: the
// «Синергія» push (WorktreeService.pushBranch) and the project wizard's ls-remote and clone
// (docs/specs/2026-11-18-first-run-and-project-wizard.md, decision 6). The project's GIT_TOKEN
// reaches git as a credential helper through the environment — never the command line, the URL
// or the output — so an https remote authenticates as the project's account and the clone's
// `origin` stays token-free. Without a token, and over SSH, the machine's own credentials do.
// No call may ever wait on a prompt: the api has no terminal to answer it.

// The username a token authenticates with differs per host: GitHub takes any non-empty name with
// a PAT and documents `x-access-token`, GitLab wants `oauth2`, Bitbucket `x-token-auth`. An
// `~/.ssh/config` alias (`github.com-work`) is still GitHub.
export function tokenUsername(url?: string): string {
  const host = remoteHost(url ?? "");
  if (!host) return "x-access-token";
  if (host === "bitbucket.org") return "x-token-auth";
  if (host.startsWith("gitlab.")) return "oauth2";
  return "x-access-token";
}

// `ssh://…` or the scp form `user@host:path` (a `C:\` drive is not one).
export function isSshUrl(url: string): boolean {
  const s = url.trim();
  if (/^ssh:\/\//i.test(s) || /^git\+ssh:\/\//i.test(s) || /^ssh\+git:\/\//i.test(s)) return true;
  return !s.includes("://") && /^(?:[^@/\s]+@)?[^:/\s]{2,}:/.test(s);
}

function remoteHost(url: string): string | null {
  const s = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(s);
  if (scheme) return scheme[1]!.toLowerCase();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):/.exec(s);
  return scp ? scp[1]!.toLowerCase() : null;
}

// What ssh runs with when the operator has not chosen otherwise: never ask (a passphrase, a
// password), and take a first-seen host key instead of asking about it — a changed one is still
// refused.
const BATCH_SSH = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new";

// `process.env` plus: no terminal prompt; with `token`, a credential helper that answers with it
// (the machine's helpers are reset first, so a stale keychain entry cannot win); for an ssh `url`,
// a batch-mode ssh unless the environment already names its own GIT_SSH_COMMAND.
export function credentialEnv(token: string, url?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (token)
    Object.assign(env, {
      KERMANYCH_GIT_TOKEN: token,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: `!f() { test "$1" = get && echo username=${tokenUsername(url)} && echo "password=$KERMANYCH_GIT_TOKEN"; }; f`,
    });
  if (url && isSshUrl(url) && !env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = BATCH_SSH;
  return env;
}

// `text` with every occurrence of `token` masked: git echoes URLs and helper output in its
// errors, and none of it may carry the secret back to the UI or a log.
export function scrubToken(text: string, token?: string): string {
  return token ? text.split(token).join("***") : text;
}
