# Machine resource profile: Kermanych sizes its own load to the machine

## Goal

A developer reports that his machine nearly freezes once 6+ `node` processes run. He sees it on
mode «Керманич» with `claude` and also after switching to `omp`, so the cause is not the
runtime. Kermanych has to detect how strong the machine is, propose a configuration, apply it
after the operator agrees, and protect the machine from one runaway agent.

Follow-up to `2026-10-21-claude-resource-limits.md`, which covered limits set outside
Kermanych and stays valid.

## Context

- **No limit exists today.** The only limit is the idle reaper
  (`supervisor.service.ts` `reapIdleChildren`, 15 min, `done`/`in_review` only). Nothing caps
  how many agents run at once or what one agent runs inside.
- **Where the load comes from.** Every session repeats it:
  - stdio MCP servers of the project: `.mcp.json` with `npx …` starts 2 `node` per session,
    on both runtimes;
  - LSP (tsserver);
  - subagents (defaults: omp `task.maxConcurrency = 32`, claude 20);
  - background commands (omp `bash.autoBackground.enabled = true`, claude `run_in_background`);
  - test runners. Jest and vitest default to one worker per core. Neither has an env variable
    for the worker count.
- **Tool access by session kind** (`chat-tools.ts` `launchToolsFor`). Only `kind: "agent"`
  sessions have Bash. Chats and reviews run with read/grep/glob, discussions with no tools.
- **Status `queued` already exists.** The UI shows it as «у черзі» (`i18n/uk/index.ts:347`). It
  means "child is starting" (`supervisor.service.ts` `wireLive(…, "queued")`).
- **Config precedence differs between the runtimes:**
  - omp: `--config` overlays override the project `.omp/config.yml` and the global
    `~/.omp/agent/config.yml` (`omp://config-usage.md`, Layers).
  - claude: `env` in `~/.claude/settings.json` replaces the process environment, so it beats
    the SDK `env` option ([docs](https://code.claude.com/docs/en/env-vars)).
- **Precedent for reading the operator's omp config.** `skills.service.ts` (`omp config get`,
  run in the session cwd) already reads it so that an overlay does not erase it.
- **What macOS exposes:**
  - `os.totalmem()`, `os.availableParallelism()`;
  - `sysctl hw.perflevel0.physicalcpu` (performance cores);
  - `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
  - `os.freemem()` is useless on macOS: it excludes cache, and showed 1.4 GB "free" of 48 GB.
- **Settings screen.** There is no profile page. Settings → Застосунок holds «Загальне»,
  «Гарячі клавіші», «ШІ-провайдер» and «Акаунт» (`lib/settings.ts`). Its rail says «Діє для цієї
  машини, поза акаунтом і проєктами».
- **The onboarding runtime gate** (`MainLayout.vue`, `KModal`, `showOnboarding`) is the
  existing modal pattern.

## Decisions

### 1. Detection and profile

On api start Kermanych reads RAM, logical cores and performance cores (fallback: logical). It
maps them to a profile. RAM picks the tier. Test workers are also capped by half the
performance cores.

| RAM | Profile | Agents at once | Subagents per session | Background commands | Test workers (prompt) |
|---|---|---|---|---|---|
| ≤ 8 GB | Мінімальна | 1 | 1 | off | 1 |
| ≤ 16 GB | Базова | 2 | 2 | off | 2 |
| ≤ 32 GB | Середня | 3 | 4 | on | 2 |
| ≤ 64 GB | Потужна | 5 | 6 | on | min(4, perf cores / 2) |
| > 64 GB | Максимальна | 8 | 8 | on | min(6, perf cores / 2) |

Every profile also lowers process priority (nice 10) and enables the watchdog. The pure
function `(ramBytes, cores, perfCores) → profile` lives in `@kermanych/core` so the API and the
UI use one table.

### 2. Consent popup

A dismissible `KModal` in `MainLayout`. It is shown when:

- no decision is stored on this machine, or
- the stored hardware fingerprint (RAM bytes, logical cores, perf cores) differs from the
  detected one, or
- the operator presses «Визначити заново» in the section.

The popup shows the detected hardware and the table row that will apply. Buttons:

- **«Застосувати»**: stores `applied`. Limits and the watchdog take effect.
- **«Налаштувати»**: opens Settings → Застосунок → «Ресурси машини» with the detected values as
  an unsaved draft.
- **«Не зараз»**: stores `declined`. Nothing is limited, which is today's behaviour, watchdog
  included. The popup does not come back until the hardware changes. The section can still
  switch it on.

Closing the modal any other way stores nothing, so it shows again on the next start.

### 3. Storage: this machine only

A single-row SQLite table in the registry (`machine_resources`, `CHECK (id = 1)`), the same
custody rule as `auth_session`. Columns:

- hardware fingerprint;
- `decision` (`applied` | `declined` | null);
- operator overrides (JSON, only the keys the operator changed).

Effective values = profile, then overrides. It never goes to the cloud: one user can have two
machines with different profiles.

API:

- `GET /machine/resources` returns hardware, detected profile, effective values, decision,
  current pressure level, and for each in-agent limit the source that overrides it (decision
  10).
- `PUT /machine/resources` with `{ decision?, overrides? }`.
- `POST /machine/resources/redetect` re-reads the hardware and clears the stored decision, so
  the popup shows.

### 4. Agent slots

The limit counts sessions with `kind: "agent"` (managed and native) whose turn runs:
`queued` (starting), `thinking`, `tool`, `waiting_input`. It does not count:

- a session waiting for a slot;
- `done` / `in_review`, even when the reaper still keeps its child;
- chats, reviews, discussions, the Менеджмент chat and one-shots (release notes, Slack).

A native agent holds its slot while its TUI process lives. Kermanych gates its start and
«Продовжити», not what the operator types into the terminal.

### 5. The queue

These wait for a slot:

- a new agent launch;
- a message to an agent in `done` / `in_review`;
- «Продовжити» of a native agent.

Behaviour:

- **Status.** A waiting session stays in `queued`. The session payload carries
  `slotWait: { position, running, limit }`, and the card shows «чекає на слот · 2 з 2
  працюють».
- **What waits.** The worktree and branch are created at once. Only the child spawn waits.
- **Order.** FIFO by enqueue time.
- **Pending message.** A message sent to a waiting session shows in its log as «надіслано,
  чекає на слот». It is stored on the session row (`pending_prompt`), so a restart does not
  lose it.
- **Bypass.** «Запустити зараз» on a waiting card bypasses the limit for that one session.
- **App restart.** Agent sessions left in `queued` with no child, or holding a
  `pending_prompt`, are re-enqueued in their original order.
- **Releasing a slot.** A turn reaching `done`/`in_review`/`error`/`stopped`, a stop, delete
  or finish, and the death of a native TUI all release it. The next waiting session starts.
- **Limit change.** Lowering the limit stops nothing that already runs. Raising it starts
  waiting sessions at once.
- **Decision `declined`.** No queue at all.

### 6. Limits inside each agent

These are applied at spawn, so a running child gets them on its next spawn (resume after the
reaper, restart):

- **omp:**
  - a second `--config` overlay (omp accepts the flag repeated) per session with
    `task.maxConcurrency` and `bash.autoBackground.enabled`;
  - `RpcSession` takes a list of config paths instead of one.
- **claude:**
  - SDK `env: { ...process.env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS }`;
  - native claude gets the same variables in its pty environment.
- **Priority:**
  - `os.setPriority(pid, 10)` on the agent process right after spawn: the omp child, the
    claude CLI (`initializationResult().pid` or `spawnClaudeCodeProcess`), the native pty
    child;
  - descendants inherit nice;
  - applies to every agent kind, chats included;
  - a running child is reniced at once when the operator turns it on.
- **Prompt:**
  - `systemAppendOpts` adds one paragraph: «Ця машина: <RAM>. Запускай тести щонайбільше з
    <N> воркерами (`--maxWorkers=<N>` для jest/vitest), ніколи не запускай два тест-рани
    одночасно, не використовуй watch-режим.»;
  - English text when the agent language is English, the same way the language directive is
    resolved;
  - this is the only lever for jest and vitest.

### 7. Watchdog

Runs only with decision `applied` and on macOS. On other platforms the section says it is
unavailable.

- **Sampling:**
  - every 5 s it reads `kern.memorystatus_vm_pressure_level`;
  - at level ≥ 2 it also takes one `ps -axo pid,ppid,rss,command` snapshot and builds each
    agent child's process tree.
- **Baseline:**
  - when a session's child becomes ready, Kermanych records the pids of its descendants at
    that moment: MCP servers, `__omp_worker_*`, the omp Python kernel;
  - those subtrees are never victims;
  - a process started later (a tool command, a lazily started LSP) is a candidate.
- **Level 2 (warn):**
  - one in-app notice plus a native notification per pressure episode (an episode ends when
    the level returns to 1);
  - it names the heaviest agent and its heaviest candidate subtree («Сесія X: `npm test` —
    9 GB»);
  - button «Зупинити команду» kills that subtree.
- **Level 4 (critical) for two consecutive samples:**
  - Kermanych picks the heaviest candidate subtree of at least 1 GB across all agents;
  - it sends SIGTERM to the whole subtree (SIGKILL after 3 s);
  - it then posts into that session: «Команду `<command>` зупинено: на машині закінчилась
    пам'ять. Повтори її з меншою кількістю воркерів або частинами.»;
  - for a managed child that message is a steer while the turn runs and the next prompt
    otherwise; for a native session it is typed into the pty, the same way helper prompts
    are;
  - the agent itself stays alive;
  - cooldown 30 s before the next kill.
- **No candidate of at least 1 GB:**
  - only a notice «Пам'ять закінчується, агенти Керманича тут ні до чого»;
  - Kermanych kills nothing.
- **Known blind spot:**
  - a process that detached from the agent (`setsid`, daemon, parent became `launchd`) is not
    in any agent tree, so the watchdog cannot see it;
  - the doc says so.

### 8. Settings section «Ресурси машини»

A new row `app-resources` in `SETTINGS_CATEGORIES` (scope `app`) with a pane in
`SettingsPage.vue`. It contains:

- **Detected:** «48 GB · 14 ядер (10 продуктивних + 4 енергоощадні) → профіль "Потужна"», and
  the current pressure level, refreshed while the pane is open.
- **Switch:** «Застосовувати обмеження», which is the decision.
- **Editable values:** agents at once, subagents per session, background commands, test
  workers, lower priority, watchdog on/off, and the watchdog action at level 4 (kill the
  command, or notify only).
- **Overrides:** next to each in-agent limit, the source that overrides it (decision 10).
- **Buttons:** «Визначити заново» and «Скинути до профілю».

It uses the screen's existing draft and save bar. «Акаунт» links to it.

### 9. What is applied when

| Change | Takes effect |
|---|---|
| Agent limit | At once |
| Priority switch | Renices running children at once |
| Watchdog | At once |
| Subagents, background commands, test workers | On a child's next spawn |

### 10. The operator's own config wins

- **omp:**
  - before writing the resources overlay, Kermanych reads `task.maxConcurrency` and
    `bash.autoBackground.enabled` in the session cwd the way `skills.service.ts` reads
    `skills.customDirectories`;
  - a key set by the project or global layer is left out of the overlay.
- **claude:**
  - nothing extra is needed: settings `env` already wins;
  - for display, Kermanych reads the `env` blocks of `~/.claude/settings.json` and the
    project's `.claude/settings*.json`.
- **Display.** The section shows «перекрито вашим `~/.omp/agent/config.yml`:
  `task.maxConcurrency = 32`» (or the claude file).
- **Not affected.** Agent slots, priority, the prompt paragraph and the watchdog are
  Kermanych's own and always apply.

## Rejected alternatives

- **Recommendation only, no auto-apply.** Nothing is limited until a person acts.
- **A static profile only, no pressure check.** It cannot see Docker, the IDE or a browser
  eating the memory.
- **A mandatory, non-dismissable popup like the runtime gate.** One more barrier on first sign-in
  for something Kermanych can run without.
- **Showing the popup on every start until accepted.** «Не зараз» would mean nothing.
- **Counting every live session, or every live child, in the limit.** Chats would wait behind
  agents running tests, and opening an old session (a resume) would queue.
- **A new status `waiting_slot`.** It touches `SessionStatus` in `@kermanych/core`, cloud status
  sync and every UI status switch. `queued` already reads «у черзі».
- **Queueing only new launches.** Messages to old sessions would bypass the limit.
- **Storing the profile in the cloud account.** A second machine would inherit the first
  machine's limits.
- **Putting it under «ШІ-провайдер».** That section is cloud-backed, and the profile is
  machine-local.
- **The Kermanych profile always wins.** Silently erases the operator's omp config, and cannot
  hold for claude without changing `settingSources`.
- **Pausing (SIGSTOP) instead of killing.** It frees no memory, and the agent's Bash call
  times out anyway (claude: 2 min).
- **Killing the heaviest subtree regardless of kind.** It may take MCP or LSP away from the
  agent.
- **Stopping the whole agent.** It loses the turn.
- **`ulimit -u` / `launchctl limit maxproc`.** These apply to the whole account or system.
- **Memory caps.** macOS has no cgroups. `CLAUDE_CODE_TOOL_MEMORY_LIMIT` is Linux/WSL only.

## Edge cases

- **Hardware fingerprint changed** (new Mac restored from a backup): the popup shows the new
  profile. Overrides are kept but shown against the new profile.
- **Limit lowered below the running count:** no running agent stops. The queue waits until
  the running count drops below the new limit.
- **Waiting session deleted or stopped:** removed from the queue and its `pending_prompt` is
  dropped.
- **Agent in `waiting_input`:** holds its slot. It is mid-turn and blocked on the operator.
- **Watchdog kills a command the agent started as a background job:** the job ends. The
  message tells the agent which one.
- **Non-macOS:** profile, queue, priority and in-agent limits work. The watchdog is off.

## Verification

Unit tests (api and core, existing vitest suites):

- profile tier boundaries (8/16/32/64 GB) and the perf-core cap on workers;
- the slot gate:
  - FIFO;
  - the release triggers listed in decision 5;
  - «Запустити зараз»;
  - a raised limit draining the queue;
  - re-enqueue after restart, `pending_prompt` included;
  - chats, reviews and discussions not counted;
- watchdog victim choice:
  - baseline pids excluded;
  - the 1 GB threshold;
  - two-sample confirmation;
  - cooldown;
- omp overlay content with and without the keys set in project or global config.

Smoke on a real machine:

- Limit 1 in the section. Launch two agents: the second shows «чекає на слот · 1 з 1» and
  starts when the first settles.
- Send a message to a `done` agent while the slot is busy: it waits and is delivered after.
- `ps -o nice=` on an agent child and on a command it runs: `10`.
- An agent runs `node -e` allocating 2 GB. `sudo memory_pressure -S -l warn` produces the
  notice. `sudo memory_pressure -S -l critical` kills that command, not the MCP server, and
  the session receives the message.
- «Не зараз» → none of the above happens.

## Documentation impact

- `kermanych/README.md`: a «Ресурси машини» section (profile, popup, queue, watchdog, what the
  operator's config overrides).
- `kermanych/docs/claude-resource-limits.md`: note that Kermanych now sets the claude variables
  itself, and that `settings.json` `env` still wins.
- `docs/specs/2026-10-21-claude-resource-limits.md`: pointer to this document.
