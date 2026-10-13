# «Знахідки»: agents report side findings, the operator files them as tasks

- **Date:** 2026-10-13
- **Scope:** `packages/core` (finding shape, description renderer), `apps/api` (registry table,
  session MCP server, routes), `apps/ui` (session «Знахідки» tab, filing dialog), README.
- **Builds on:** `docs/specs/2026-10-05-embedded-browser.md` (the per-session `kermanych` MCP
  server), `docs/specs/2026-10-05-docs-mid-session.md` («Задача з документа»).

## Goal

The operator asked (session `inodi-poly-ahenty-vykonuiut-iakus-robotu`, 2026-10-13): while
agents do their work they find problems that are not part of it. Can agents file tasks for
them, automatically or semi-automatically, in Kermanych or in Jira?

The answer settled in the interview is **semi-automatic**. The agent records a structured
*finding* and keeps working. The operator sees the session's findings, edits one if needed,
and in one click files it as a card on the workspace board or as a Jira issue. Or the operator
dismisses it.

## Context

- **Native board.** `public.tasks` rows are always written under a user's JWT. RLS requires
  `created_by = auth.uid()`, and there is no service-role key. New rows default to `backlog`.
  There is no draft/inbox status, and no column records an agent or session as origin. The api
  already creates rows itself (`SupervisorService.promotionCard`, Jira/Linear shadow tasks),
  and the board picks up any insert through realtime (`subscribeTasks`).
- **Jira.** Every write is signed with the operator's **personal** token from local SQLite
  (`jira_tokens`). There is no bot or service account. Two create paths exist: the Менеджмент
  child's MCP tool `jira_create_issue`, and `POST /jira/issues/:integrationId` →
  `JiraService.createIssue(integrationId, JiraIssueDraft, userId)`, which the Jira board's
  `JiraIssueEditor.vue` uses. `GET /jira/editor-options/:integrationId` serves issue types. A
  workspace connects up to 10 boards. A board is not mapped to a Kermanych project.
- **Session agent tools.** A session child gets exactly one MCP server (`RuntimeLaunchOpts.mcp`
  is a single `{name, url, token}`). Today that is the browser server
  (`BrowserMcpService`, name `kermanych`, `POST /api/browser/mcp`, per-session bearer). It
  reaches managed omp and claude sessions, chats, and native TUIs (`--mcp-config` /
  `--hook bridge`). Discussion and review forks get none. `bindingFor` returns `undefined`
  when there is no Electron `browserHost()`, so a standalone api gives agents no server.
- **Agent → card fence** (`packages/core/src/task-actions.ts`, `qa-checklist`) parses finished
  assistant text of task-born sessions only. It cannot answer the agent and does not reach
  native sessions.
- **Identity.** The api serves one signed-in operator (`AuthService.current()`). `Session` has
  `projectId` and `taskId`, no user or workspace. The workspace comes from `Project.workspaceId`.

## Decisions

1. **Semi-automatic: the agent proposes, the operator files.** Nothing reaches the board or
   Jira without the operator's click. Rejected: automatic filing. Every write is signed as the
   operator (JWT, personal Jira token), so an unattended agent would write into a shared Jira in
   a person's name. Agents also produce duplicates and misdiagnoses, and with no draft status
   they would land straight in the team's `backlog`. Rejected: manual only (the agent mentions
   problems in prose). That is today's behaviour and changes nothing.

2. **The agent reports through MCP tools on the existing per-session `kermanych` server:
   `report_finding` and `list_findings`.** The api validates the arguments, stores the finding
   and answers at once: the new id, or a refusal naming the bad field. `list_findings` lets the
   agent check what it already reported before it reports again. To make this possible:
   - `BrowserMcpService.bindingFor` no longer requires `browserHost()`. It needs only a port.
   - `tools/list` returns the findings tools always, and the browser tools only when a browser
     host exists. `call()` checks for the host only for browser tools.
   - The server name, path and bearer stay as they are. No second MCP server: the
     one-server-per-child limit (`RuntimeLaunchOpts.mcp`, the omp bridge's single env pair,
     `claudeMcpConfigPath`) stays untouched.
   - Coverage: whatever gets the server today (managed agent and chat sessions, native
     sessions). Discussion and review forks still get none.

   Rejected: a `kind: "finding"` block in the `kermanych-action` fence. The agent gets no
   confirmation and no duplicate signal, the block shows in the transcript, it is parsed only
   for task-born sessions, and native sessions are not parsed at all. Rejected: both channels,
   which means two contracts for one action.

3. **Targets: the native board and Jira.** The filing dialog has a «Дошка / Jira» switch.
   - Board: `board.createTask` under the operator's JWT, as «Задача з документа» does.
   - Jira: the existing `POST /jira/issues/:integrationId` (`JiraService.createIssue`) under the
     operator's personal token. The Jira choice is disabled, with a hint pointing to where the
     token is added, when the workspace has no connected board or the operator has no token
     for its site.

   Rejected for now: Linear. It has a REST create path, but no README section, no spec and no
   known use. Adding it later is one more switch option and one call.

4. **Findings are stored locally in SQLite: `session_findings`, owned by the session.** The
   operator who sees them is the one on whose machine the agent runs, and whose name will sign
   the card or issue. No Supabase migration and no RLS. Works offline, next to the sessions and
   transcripts that are local too. Deleting a session deletes its findings, and deleting a
   project deletes its sessions' findings. Rejected: a cloud `findings` table for team triage.
   That is a larger feature with its own open question: who may approve a teammate's finding,
   and whose Jira token signs it. Rejected: a board card with `hidden = true` as a draft.
   `hidden` means «off the kanban», not «unapproved», and the card would still show in the
   assignee's «Задачі».

5. **UI: a «Знахідки» tab in the session detail on «Агенти», plus a counter.**
   - The tab sits next to «Документація». Each row shows the title, kind, context and evidence,
     with «Створити задачу →» and «Відхилити». Filed rows show their card or Jira key as a
     link. Dismissed rows show their state.
   - The counter of `open` findings shows on the tab label and on the session card in the
     sidebar.
   - A new finding reaches the UI as an ordinary `session_update` (`Session.openFindings`)
     over `EventsGateway`. No new event type.
   - Reporting does not change the session status. It is never `waiting_input`, and the agent
     is not blocked.

   Rejected for now: a cross-session «Знахідки» page. Same data, more navigation. Worth adding
   once real use shows many findings. Rejected: a toast only. Easy to miss, and it leaves
   nowhere to come back to.

6. **The agent's instructions live only in the tool descriptions.** Every runtime reads MCP
   tool descriptions (omp, claude, native TUIs). The native-session rule «nothing of Kermanych
   in the agent's context» is kept the same way the browser tools keep it, and no system prompt
   grows. The `report_finding` description states:
   - Report a real problem **outside the current task**: a bug, a vulnerability, broken or dead
     code, docs that contradict the code, significant tech debt. Something inside the current
     task is fixed, not reported.
   - **Do not get side-tracked.** Record it and continue. Do not fix it on this branch unless
     the operator asked.
   - Only what was **seen** in code or output, with `path:line` references or a reproduction
     command. No guesses, no style advice.
   - Call `list_findings` first and do not repeat a finding, including a dismissed one.
   - Write the fields in English (as Менеджмент tickets are). The title is at most 120
     characters.

   Rejected: a line in `systemAppendOpts` (managed sessions only, so the runtimes would
   diverge). Rejected: an overridable default skill (skills reach omp only through `--config`,
   not managed claude).

7. **The finding's shape.**

   | Field | Required | Content |
   |---|---|---|
   | `title` | yes | one line, ≤ 120 characters |
   | `kind` | yes | `bug` \| `security` \| `tech-debt` \| `docs` |
   | `context` | yes | what is wrong and why it matters |
   | `evidence` | yes | non-empty array: `path:line` references and/or reproduction commands |
   | `acceptanceCriteria` | yes | non-empty array: what must be true once it is fixed |
   | `suggestedFix` | no | a short fix idea |

   Stored as well: `id`, `sessionId`, `status` (`open` \| `filed` \| `dismissed`),
   `createdAt`, `updatedAt`, and for a filed finding its target (`board` + task id, or `jira` +
   issue key + URL).

   `list_findings` returns this session's findings in all three states (id, status, kind,
   title, and the key or card when filed).

   **Limit:** at most 20 `open` findings per session. Beyond that `report_finding` refuses
   with a message telling the agent to stop and mention it to the operator. This guards against
   a runaway loop. The number is a constant, not a setting.

8. **Filing.** «Створити задачу →» opens one dialog, prefilled. Every field can be edited
   before creating.
   - **Description:** the Менеджмент ticket markdown (`renderTicketDescription`: «Context»,
     «Acceptance criteria» as `- [ ]`) plus «Evidence» and, when present, «Suggested fix».
     The last line is the origin: project, branch, session, as in «Задача з документа». The
     renderer lives in core, next to `renderTicketDescription`.
   - **Board:** the project defaults to the session's project. Any other project of the same
     workspace may be chosen, because a frontend agent often finds a backend problem. Assignee
     is optional. Model and effort come from the target project's defaults. Platform is empty.
   - **Jira:** the board is chosen when several are connected (one is preselected when there
     is one). The issue type defaults to `Bug` for `bug`/`security` and to `Task` otherwise. If
     the site has no type of that name, the first available type is used. Labels are
     `kermanych-finding` plus the kind.
   - On success the finding becomes `filed` with its target. A failed create leaves it `open`
     and shows the error in the dialog (Jira's flattened refusal text).
   - «Відхилити» sets `dismissed`. There is no undo in this change.

   Who performs each write: the UI creates the board card (operator's JWT) and then reports
   the result to the api. The Jira create goes through the existing Jira route. The api's
   findings routes only change local finding state.

### Out of scope

- Automatic filing, and a per-project «file without confirmation» switch.
- Linear as a target.
- A cloud/team triage list, and a cross-session findings page.
- Findings tools for discussion and review forks.
- Undoing a dismissal; editing a finding in place apart from the filing dialog.

## Changes

- **Core:** `AgentFinding`, `FindingKind`, `FindingStatus` types, a validator for
  `report_finding` arguments, and `renderFindingDescription()` (reusing
  `renderTicketDescription`). `Session.openFindings?: number`.
- **API:**
  - Registry: `session_findings` table (`id`, `session_id`, `status`, `kind`, `title`,
    `context`, `evidence` JSON, `acceptance_criteria` JSON, `suggested_fix`, `target_kind`,
    `target_ref`, `target_url`, `created_at`, `updated_at`); deleted with its session and its
    project; open count joined into session listing.
  - `BrowserMcpService`: binding without a browser host; `report_finding` / `list_findings`
    beside the browser tools; browser tools listed only with a host. After a report the
    supervisor emits `session_update`.
  - Routes: `GET /sessions/:id/findings`;
    `POST /sessions/:id/findings/:findingId/filed { kind: "board", taskId } | { kind: "jira",
    key, url }`; `POST /sessions/:id/findings/:findingId/dismiss`. 404 for an unknown session
    or finding, 400 for a finding that is not `open`.
- **UI:** `api` and store methods; the «Знахідки» tab in `AgentsPage.vue`; the filing dialog
  (board/Jira switch, project, assignee, Jira board and issue type, title, description); the
  counter on the tab and on `KSessionCard`; uk/en strings.
- **Docs:** README «Session browser» (the `kermanych` server now also carries the findings
  tools and exists without the desktop app), and a findings paragraph under «Cloud tasks and
  local sessions».

## Verification

- Core unit tests: the validator (required fields, kind vocabulary, title length, empty
  arrays) and the description renderer.
- API tests: the `session_findings` round trip and the deletion cascade; `report_finding`
  stores, refuses bad arguments and enforces the open limit; `list_findings` returns all
  states; `tools/list` with and without a browser host; the filed/dismiss routes and their
  404/400 cases.
- Smoke on a preview api (`KERMANYCH_PREVIEW=1`) with the UI dev server: call
  `report_finding` over `POST /api/browser/mcp` with the session's bearer, see the counter and
  the row appear live, file one finding to the board, dismiss another, and check both states
  through `list_findings`. A Jira create is exercised only if a Jira site and token are
  available. Otherwise the disabled Jira option and its hint are what is checked, and this is
  reported as such.

## Documentation impact

`kermanych/README.md`: «Session browser» (the server's tools and its availability) and «Cloud
tasks and local sessions» (what findings are, where they appear, how they become a card or a
Jira issue, and that nothing is filed without the operator).
