# Limiting the processes claude starts, without Kermanych

## Problem

A developer runs Kermanych in mode «Керманич» on the claude provider. During work he sees
6+ `node` processes and the machine stops responding.

Facts found:

- The managed claude child is the Agent SDK's native binary (`claude-agent-sdk-darwin-arm64`,
  Mach-O, about 250 MB RSS), not node. With no stdio MCP configured, an idle child starts no
  processes (probe of `ClaudeCodeRuntime`'s launch options).
- The `node` processes come from what claude runs: Bash commands (test runners spawn a worker
  per core), subagents (up to 20 in parallel by default), background commands, and stdio MCP
  servers, started again in every claude session.
- The "omp limit" the operator remembered is the idle reaper (`97679de`,
  `supervisor.service.ts` `reapIdleChildren`). It is runtime-neutral and already stops
  `done`/`in_review` claude children after 15 minutes idle. Kermanych has no other process or
  concurrency limit for either runtime.

## Decision

The operator chose limits outside Kermanych. The deliverable is a how-to,
`kermanych/docs/claude-resource-limits.md`, linked from the README's «Runtime preference».
Kermanych code does not change in this task.

Follow-up: the same day the developer saw the freeze on `omp` too, and the operator asked for
limits inside Kermanych after all. That is `2026-10-21-machine-resource-profile.md`; it does not
replace this how-to, which still covers claude outside Kermanych.

The how-to uses only Claude Code's own settings (`env` in `~/.claude/settings.json` or the
managed settings file):

- `CLAUDE_CODE_SHELL_PREFIX` → a wrapper that runs every Bash command, hook and stdio MCP
  server under `nice -n 10`, or `taskpolicy -b` for a stronger limit.
- `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`,
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
- Fewer stdio MCP servers, worker limits in the project's test runner.

## Constraint this puts on Kermanych

The settings reach Kermanych's claude sessions only because `ClaudeCodeRuntime` passes no
`settingSources` (the SDK then loads user, project and local settings). A future change that
isolates the child (`settingSources: []`, `strictMcpConfig`) silently drops these limits. Such
a change must carry the user's `env` over or document the loss.

## Rejected

- **Limits in Kermanych code** (a cap on live claude children, `env` injected by Kermanych,
  process-group kill). The operator asked for limits that do not depend on Kermanych. The
  Kermanych-side defects found during the analysis are reported as findings, not fixed here.
- **`ulimit -u` / `launchctl limit maxproc`.** These cap the whole user account or system, so
  the browser and the IDE break too.
- **`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`.** It exists in the binary but is undocumented.
- **Memory caps.** `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is Linux/WSL only, and macOS has no cgroups.

## Verification

- `claude -p` 2.1.285 with `--settings` carrying the `env` block: the Bash command reported
  `NICE=10 PREFIX=<wrapper> SUB=2`.
- The SDK 0.3.259 child launched with Kermanych's options (no `settingSources`), with the same
  block in the project's `.claude/settings.json`: `NICE=10 PREFIX=<wrapper> SUB=2`.
- The SDK child's `initializationResult()` lists the user's `superpowers:*` plugin commands, so
  user settings and plugins load on the managed path.
- `taskpolicy -b bash -c 'bash -c "ps -o pri= -p $$"'` → priority `4` in the grandchild
  (normal `31`): background policy is inherited.
