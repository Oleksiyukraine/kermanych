# Pointing one session's agent at another session's document

- **Date:** 2026-10-20
- **Scope:** `apps/api` (one route), `apps/ui` (a document picker in the composers, «Копіювати
  посилання» in the «Документація» tab, en/uk strings), README «Project documentation».
- **Builds on:** `docs/specs/2026-10-05-docs-mid-session.md` («Задача з документа»).

## Goal

An agent writes a handoff, an API request, a spec or another document during its task. Until the
branch merges, that file exists only in the session's worktree,
`~/.kermanych/worktrees/<sessionId>/…`. If the operator wants another agent to use it, they must
explain each time that the file is not in the repository and say where it is. The fix is that
Kermanych writes this reference itself, so the operator never types a worktree path.

## Context

- Every worktree session has its own directory (`worktreeDir`, `Session.worktreePath`).
  `WorktreeService.changedFiles(dir, base)` lists everything the branch produced: committed,
  staged, unstaged and untracked files.
- The session's «Документація» tab shows the documentation among those files («Змінені»,
  `changedDocsView`). For an `api-request` / `handoff` it offers «Задача →», which creates a card
  in **another** project of the workspace or copies the whole text. No row gives a path, and a
  session of the same project cannot be a target.
- Agents can already read other worktrees. claude-code runs with `canUseTool → allow`, and omp has
  no sandbox. The only thing missing is that the agent does not know where the file is.
- «Завершити» commits the documents onto the session's branch, keeps the branch and removes the
  worktree (`apps/api/test/supervisor.docs-gate.spec.ts:136-139`). A reference made earlier
  therefore points at a path that no longer exists.

## Decisions

1. **Two entry points, one reference text.**
   - **Picker in the composer.** The operator picks a document of another live session. A
     deterministic reference is inserted into the draft at the cursor.
   - **«Копіювати посилання»** on each row of «Змінені» in the «Документація» tab, while the
     worktree exists. It copies the same reference to the clipboard. This is the route for
     native sessions, which type into a TUI and have no composer.

   Rejected alternatives:
   - An MCP tool `session_documents`: it works only if the agent decides to call it, session names
     can be ambiguous, and native sessions have no MCP.
   - A list of live sessions in every spawn's system prompt: it goes stale as sessions start, and
     it lengthens every prompt.
2. **Documents: the «Змінені» set.** These are the documentation files the branch changed
   (`isDocPath` over `changedFiles`), uncommitted and untracked ones included: specs, plans,
   schemas, handoffs, API requests, README edits. This is the same set the tab already shows.
   The task asks for «будь-який інший документ», not only handoffs.
3. **Sessions: every live worktree session on this machine.** That means `worktree: true`,
   not `merged`, and its directory exists. All projects are included, whatever their workspace:
   they are all the operator's sessions on the operator's disk, so a workspace boundary would
   only hide them. The session being typed in is excluded. Groups are ordered with the current
   project first, then the others by name. Inside a group, sessions are ordered by most recent
   activity first. In-place sessions (`worktree: false`) are left out because their files are
   already in the project checkout, which is not the problem this task solves.
4. **Trigger: a button and `@` at the start of a word.** The button sits beside `/` (helpers) and
   📎. `@` opens the picker only at the start of the draft or after whitespace. The text typed
   after it filters the list by session name, project name and file path. `Esc` or a space
   closes the picker and leaves the `@` as plain text. A pick replaces `@query` with the
   reference. This follows the helpers pattern, where `/` has both a key and a button.
5. **Where: every place the operator writes to an agent.** These are `KComposer` (agent sessions
   and chats), the «Задача» field of the new-task launcher, and the «Менеджмент» chat. Known
   trade-off: launcher text becomes the cloud card's description, so workspace members see a
   local absolute path that means nothing on their machines. This is accepted because that card
   is launched on this machine.
6. **The reference text.** It names the source and gives a fallback for after «Завершити»:

   > Документ сесії «{session}» (проєкт {project}, гілка `{branch}`) ще не в репозиторії —
   > він лежить у worktree тієї сесії: `{worktreePath}/{path}`. Якщо файлу вже немає, сесію
   > завершено: прочитай `git -C {repoPath} show {branch}:{path}`.

   The language follows the UI locale (`uk` / `en`) through i18n, like every other UI string.
   Agents read either language, and the operator reads their own. Rejected alternatives: a bare
   path, which gives no context and breaks after finish, and a phrase without the fallback, which
   is a dead link for an agent started from a card the next day.
7. **Data comes fresh on each picker open.** The picker calls the API every time it opens and
   keeps no cache. A document written a minute ago appears, and a session that finished
   meanwhile does not.

## Changes

- **api:** `GET /sessions/documents?exclude=<sessionId>` →
  `{ sessionId, sessionName, projectId, projectName, branch, worktreePath, repoPath, lastActivityAt,
  docs: { path, kind? }[] }[]`. It covers live worktree sessions whose directory exists (decision 3).
  `docs` is `changedFiles(dir, base)` filtered by `isDocPath`, and `kind` comes from
  `docsLayoutKind`. Sessions are listed in parallel. A session whose git call fails is skipped,
  with a `warn`, instead of failing the whole list. Sessions without documents are omitted. The
  route is declared above the `:id/…` routes.
- **ui:**
  - `api.sessionDocuments(exclude)`.
  - One reference builder (`docRefText`) over the i18n template, shared by the picker and the
    tab.
  - `KDocPicker.vue`: a grouped list with filter and keyboard navigation, modelled on
    `KHelperPicker`.
  - A composable `useDocMention(textarea, model)` that handles the `@` detection, the
    `@query` replacement and cursor placement. It is used by `KComposer`, the launcher's
    `draftTask` textarea and `ManagementPage`'s textarea.
  - «Копіювати посилання» on live «Змінені» rows in `AgentsPage.vue`.
  - en/uk strings.
- **README «Project documentation»:** covers both entry points and the route.

## Verification

- api spec for `GET /sessions/documents`, with real temporary git worktrees:
  - lists an untracked document and a committed one;
  - omits the excluded session, `merged` sessions, sessions whose directory is missing, in-place
    sessions and sessions without documents;
  - one broken worktree does not fail the list.
- ui unit tests for the `@` detection and replacement:
  - `@` at the start of the draft and after a space opens the picker; `@` in the middle of a
    word (`a@b`) does not;
  - `Esc` keeps the literal `@`;
  - a pick replaces exactly `@query`, the rest of the draft is untouched, and the cursor sits
    after the inserted reference.
- Smoke on a preview api plus `quasar dev` with two live sessions. Session A has an uncommitted
  `docs/handoffs/…`. In session B, `@hand` → pick, and the reference with A's absolute path is
  inserted. The agent reads the file. «Копіювати посилання» in A's tab puts the same text on the
  clipboard. After A is finished, the fallback `git show` command returns the document.

## Documentation impact

README «Project documentation» gains the picker, «Копіювати посилання» and
`GET /sessions/documents`.
