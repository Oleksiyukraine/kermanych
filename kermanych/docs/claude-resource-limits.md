# Limiting what Claude Code runs on your machine

Claude Code itself is one process (`claude`, about 250 MB). The machine slows down because of
what that process starts:

- **Bash commands.** Tests, builds, dev servers. One `vitest` or `jest` run starts a worker
  per CPU core by default.
- **Subagents.** Each one can run its own Bash commands. By default up to **20** run at the
  same time in one session.
- **Background commands.** A command run with `run_in_background` (a dev server, a watcher)
  stays alive after the turn ends.
- **stdio MCP servers.** Every server from `~/.claude.json`, `.mcp.json` or a plugin is started
  again for **every** claude session. A server started with `npx` is two `node` processes.

None of the settings below need Kermanych. They live in Claude Code's own settings, so they
apply everywhere claude runs: your terminal, your IDE, and both Kermanych modes («Керманич»
and `claude`). Kermanych passes no `settingSources` to the Agent SDK, so its claude sessions
read the same settings files as a claude you start yourself.

## 1. Run everything claude starts at a lower priority

macOS has no per-process memory or process-count limit for a group of processes. What it
does have is CPU and I/O priority, and children inherit it. `CLAUDE_CODE_SHELL_PREFIX` names
a wrapper that claude puts in front of every Bash command, hook, status line and stdio MCP
server it starts.

Create `~/.claude/low-priority.sh`:

```bash
#!/bin/bash
# claude passes the whole command line as one argument; re-evaluate it with a shell.
exec /usr/bin/nice -n 10 /bin/bash -c "$1"
```

```bash
chmod +x ~/.claude/low-priority.sh
```

For a stronger limit, replace `/usr/bin/nice -n 10` with `/usr/sbin/taskpolicy -b`. This runs
the commands as background work: efficiency cores only, throttled disk I/O. The UI stays
responsive under any load, but test runs get much slower and can hit claude's 2-minute Bash
timeout (`BASH_DEFAULT_TIMEOUT_MS`).

Do not run `$1` directly as a program. It is a full command line, and MCP servers such as
`npx -y <package>` break.

## 2. Limit how much runs in parallel

Add an `env` block to `~/.claude/settings.json`, next to the keys that are already there:

```json
{
  "env": {
    "CLAUDE_CODE_SHELL_PREFIX": "/Users/<you>/.claude/low-priority.sh",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "2",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1"
  }
}
```

| Variable | Effect | Default |
|---|---|---|
| `CLAUDE_CODE_SHELL_PREFIX` | Wrapper from step 1. Write an absolute path: the settings file does not expand `~` or `$HOME`. | none |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | How many subagents can run at once in one session. | 20 |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | How many levels of subagents can start more subagents. `1` turns nesting off. | 3 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` removes background commands and background subagents. Nothing stays running after a command returns. | off |

Leave `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` unset. By default claude stops background
commands when macOS reports critical memory pressure and the session has been idle for 30
minutes.

The full list: [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).

## 3. Remove stdio MCP servers you do not use

Every claude session starts its own copy of every stdio server. Five sessions with three
`npx` servers make thirty `node` processes before any work starts.

```bash
claude mcp list
```

Remove what you do not use (`claude mcp remove <name>`), disable plugins that bring servers you
do not need (`/plugin`), and prefer the HTTP version of a server when there is one: an HTTP
server is not a process on your machine.

## 4. Limit test-runner workers in the project

The biggest bursts come from test runners. Set a worker limit in the project you work on:

- vitest: `test.maxWorkers` in `vitest.config.*`, for example `maxWorkers: 2`.
- jest: `maxWorkers` in the jest config, or `--maxWorkers=50%`.

## For the whole team

To set the same `env` on every machine so that user settings cannot override it, put the block in
the managed settings file `/Library/Application Support/ClaudeCode/managed-settings.json`
(needs admin rights). See [managed settings](https://code.claude.com/docs/en/managed-settings.md).
The wrapper script must be at the same path on every machine, for example
`/usr/local/bin/claude-low-priority.sh`.

## Check that it works

Start a new session after you change the settings. Then:

```bash
echo 'Run exactly this bash command and reply with its raw output only: echo NICE=$(ps -o nice= -p $$) SUB=$CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' \
  | claude -p --model haiku --allowedTools Bash
```

The expected answer is `NICE=10 SUB=2`. With `taskpolicy -b` the nice value stays `0`; check the
priority instead with `ps -o pri= -p $$`: `4` means background, `31` is normal.

To see what is running while the machine is slow:

```bash
ps -axo pid,ppid,rss,etime,command | grep -iE 'claude|node|npm|npx' | grep -v grep | cut -c1-200
```

## What this does not limit

- **Memory.** On macOS claude has no memory cap for its commands
  (`CLAUDE_CODE_TOOL_MEMORY_LIMIT` works only on Linux and WSL).
- **The number of claude sessions.** Each open Kermanych session, chat, discussion or review
  is its own claude process with its own MCP servers. Kermanych stops a finished session's
  process after 15 minutes without activity.
- `ulimit -u` and `launchctl limit maxproc` do limit process count, but for your whole user
  account or system, including the browser and the IDE. Do not use them for this.
