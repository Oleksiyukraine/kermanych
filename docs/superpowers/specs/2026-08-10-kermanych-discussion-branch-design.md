# Kermanych — Discussion Branches (session-tree in chat)

- Status: Design approved (brainstorm), pending implementation plan
- Date: 2026-08-10
- Scope: `kermanych` (NestJS API + Quasar/Vue UI, driving `omp --mode rpc` children)

## 1. Summary

Add the ability to **branch a side conversation off a running agent** directly
from its chat, explore an idea in isolation, then either **merge** the
conclusion back into the parent or **discard** it.

Concretely: hovering a chat message shows a `⑂` icon. Clicking it spawns a
child **discussion** session that is a fork of the parent's conversation up to
"now" (tip-level). The child runs as its own `omp` process so the parent's
context never accumulates the exploration. If the exploration pans out, the
operator merges a (reviewed/edited) **summary** back into the parent as a
message; otherwise the child is discarded. The child is rendered as a nested
row under its parent on the board, visually connected.

## 2. Motivating use case

> I start task AAA. Mid-conversation a fork appears: AAA can be done as A1 or
> A2 and I'm unsure. I want to discuss A1 with the agent **without** polluting
> AAA's context — but A1 must inherit AAA's context, or it's meaningless. If A1
> works, pour the result into AAA. Otherwise delete A1.

Four requirements: (a) A1 inherits AAA's conversation; (b) AAA stays clean while
A1 is explored; (c) merge A1's result back into AAA; (d) discard A1 cleanly.

## 3. Background: how `omp` trees actually work

There are **two** distinct tree concepts in omp; the feature touches both.

1. **Session-tree** — inside one conversation. The session is an append-only
   log of entries, each with `id`/`parentId`; the active position is a single
   `leafId`. Appending creates a child of the current leaf. "Branching" moves
   the leaf / forks the log; it never rewrites history. `/tree` moves the leaf
   in the same file; `/branch` grows a branch into a **new** session file.
2. **Agent-tree** — between sessions. Subagents (the `task` tool) create child
   sub-sessions; a `parentSession` header links a fork/new session to its
   parent.

What the `omp --mode rpc` surface exposes (relevant subset):

- `{ type: "branch", entryId }` — fork from a specific entry into a branched
  session file.
- CLI `--fork <id|path>` — fork a whole session file at startup (tip-level).
- `{ type: "new_session", parentSession? }`, `switch_session`, `get_messages` /
  `get_messages_page`, `get_branch_messages`, `get_subagents`.
- **Not exposed:** `getTree()` / `navigateTree()` (the multi-branch tree and
  in-file leaf navigation). Therefore Kermanych models the branch graph itself
  (from `parentSessionId` edges), rather than reading a tree from omp.

## 4. Chosen approach

**Ephemeral "discussion child" via session fork, no worktree.**

A branch is a **new Kermanych session** in a third session mode (`discussion`)
that touches **no git**: it forks the parent's omp conversation via
`omp --mode rpc --fork <parent.ompSessionFile>`, runs in the parent's directory,
and is restricted to non-editing tools (`--no-tools`). The parent's own omp
child is never touched, so its context cannot bleed and both run in parallel.
Merge injects a reviewed summary into the parent as a message; discard tears the
child down.

Approaches rejected during brainstorm:

- **Single child, in-file leaf switching (omp-native `/tree`)** — omp RPC does
  not expose `navigateTree`/`getTree`; would require an upstream omp change and
  is serial (only one branch live). Rejected.
- **Seed a fresh session with a transcript snapshot** — omp has no "load these
  messages" API; replaying the history as one prompt is lossy (breaks prompt
  caching, tool-call/thinking fidelity). Fails requirement (a). Rejected.

## 5. Goals / Non-goals

Goals: fork the parent conversation (tip-level), isolate the parent, merge a
summary back, discard cleanly, render the parent→child link on the board.

Non-goals for v1 (deferred, not blocked):

- **Entry-level branching** ("branch from a specific past message"). v1 forks at
  the parent's current tip. Entry-level needs the omp entry `id` plumbed through
  the transcript (today `messagesToTranscript` drops ids) and confirmation that
  the RPC message payload exposes entry ids. Reserved column `branch_entry_id`
  is **not** added in v1.
- **Code/worktree merge of a branch.** Discussion children never touch code, so
  there is nothing to git-merge. (The existing `finishSession` git merge for
  worktree/in-place sessions is unrelated and unchanged.)
- **Deep nesting UI.** The data model supports arbitrary depth (a child's
  `parentSessionId`), and cascade-delete recurses, but v1 UI/tests target one
  level (branch from a top-level `agent` session).

## 6. Data model

`packages/core` `Session` gains two fields:

```ts
parentSessionId?: string;        // tree edge: null for a normal agent, = parent id for a branch
kind: "agent" | "discussion";    // default "agent"; "discussion" = fork child
```

`kind` is an explicit field (not overloaded onto `worktree: false`) because it
gates three git-sensitive code paths (see §7): the in-place single-active guard,
`deleteSession` teardown, and `finishSession` availability.

Registry migration (`registry.service.ts`), following the existing idempotent
pattern (`ALTER TABLE ... ADD COLUMN` in try/catch; defaults cover old rows, no
backfill):

```sql
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
```

Update `createSession` INSERT and `updateSession` UPDATE column lists to include
`parent_session_id` and `kind`. Both fields are static registry data, so they
propagate to the UI for free via `SupervisorService.merge()` →
`listSessions()` → `snapshot` / `session_update`. No new WebSocket event types.

Statuses reuse the existing `SessionStatus`. A discussion child uses the normal
live statuses (`thinking`/`tool`/`waiting_input`/`done`) while active. On
**merge** it becomes `merged` and is kept as read-only history (row, transcript,
edge, and forked session file retained). On **discard** it is fully removed.

## 7. Session lifecycle (`SupervisorService`)

New/changed methods.

### 7.1 `branchSession(parentId): Promise<Session>` (new)

1. Load parent `s` + group `g`. Guard: parent exists; `s.ompSessionFile` known
   (else `await refreshState(parentId)`; if still unknown → error "agent has no
   omp session yet — send a first message"); parent not streaming (else error
   "wait for the agent to finish its turn" — the append-only file must be forked
   from a settled point).
2. `registry.createSession({ groupId: s.groupId, name: "branch: <s.name>",
   task: "", worktree: false, kind: "discussion", parentSessionId: parentId,
   branch: "", worktreePath: "" })`.
3. `cwd = s.worktreePath || g.projectDir`.
4. `rpc = new RpcSession({ cwd, model, fork: s.ompSessionFile, noTools: true })`
   → spawns `omp --mode rpc --fork <parent.ompSessionFile> --no-tools`.
5. `wireLive(childId, rpc, "queued")` → `rpc.start()` → rehydrate:
   `live.transcript = messagesToTranscript(await rpc.getAllMessages())`
   (A1 shows AAA's inherited conversation) + emit `transcript_reset` +
   `refreshState(childId)` (captures A1's new `ompSessionFile`).
6. On start failure: stop child, remove row, emit `session_removed` — **no git**.
7. **No auto-prompt** (unlike `createSession`): A1 is a continuation of AAA; the
   operator types the "let's discuss A1" message.

### 7.2 Discuss

Existing `sendMessage(childId, …)`, unchanged. A1's turns append only to A1's
forked file; AAA is untouched.

### 7.3 `mergeDiscussion(childId, summary?): Promise<{ merged: true }>` (new)

1. Load child `c`; guard `c.kind === "discussion"` and `c.parentSessionId`.
2. `text = summary ?? <last assistant_text entry of c>`.
3. `wrapped = "[Branch conclusion «" + c.name + "»]: " + text`.
4. Inject: `sendMessage(parentId, wrapped, mode)`, `mode = "follow_up"` if the
   parent is streaming else `"prompt"` (`sendMessage` resumes a dormant parent
   via `doResume`). The parent visibly receives it (`sendMessage` already emits
   `transcript_append`) and takes a turn. (omp RPC has no silent-context inject;
   `prompt`/`follow_up` always trigger the agent — accepted.)
5. Retire child: stop process, set status `merged`, keep row + transcript + edge
   + forked file (read-only history). If the parent cannot be resumed
   (worktree gone), surface an error and **keep A1 intact** so the discussion is
   not lost; merge can be retried.

### 7.4 Discard

Existing `deleteSession(childId)` with a new short-circuit for
`kind === "discussion"`: stop child + best-effort `rm` the forked session file +
remove row + emit `session_removed`. **No git** (`checkout`/`removeBranch` are
skipped — the cwd is the parent's, so a checkout would be destructive).

### 7.5 Guard/lifecycle fixes required

- **In-place single-active guard** (`createSession`): change
  `!s.worktree && s.status !== "merged"` to also exclude discussion children
  (`&& s.kind !== "discussion"`), so a discussion child (which is
  `worktree: false`) is not mistaken for an active in-place agent.
- **`finishSession` / UI ✓**: reject `kind === "discussion"` (nothing to
  git-merge) and hide the ✓ finish action on discussion rows/panels. This is
  the third path `kind` gates, per §6.
- **`doResume`**: the guard `if (!s.worktree && currentBranch !== s.branch)
  throw` must be skipped for `kind === "discussion"` (branch is `""`, cwd is the
  parent's). A discussion child resumes by respawning in the parent's directory
  and `switchSession(c.ompSessionFile)`.
- **Cascade delete**: deleting a parent recursively discards its discussion
  children (they are ephemeral and hang off the parent). Merged children are
  included in the cascade.

### 7.6 `RpcSession` change (`apps/api/src/rpc/rpc-session.ts`)

Extend constructor opts: `fork?: string`, `noTools?: boolean`. In `start()`,
append `--fork <opts.fork>` and `--no-tools` to the argv when set. No other
protocol changes; branching is realized via the CLI `--fork` path, not a new RPC
command.

## 8. API / WS surface

New REST endpoints (`SessionsController`):

| Method | Route | Handler | Notes |
| --- | --- | --- | --- |
| POST | `/sessions/:id/branch` | `sup.branchSession(id)` | `:id` = parent; returns child |
| POST | `/sessions/:id/merge` `{ summary? }` | `sup.mergeDiscussion(id, summary)` | `:id` = child |
| DELETE | `/sessions/:id` | existing `deleteSession` | discard (handles discussion) |

WebSocket: **no new events.** The board draws the node + edge from
`Session.parentSessionId` in `session_update`; A1's inherited transcript arrives
via `transcript_reset`; the merged summary appears in AAA via `transcript_append`;
discard via `session_removed`.

## 9. UI (`WorkspacePage.vue` + kit)

Chosen layout: **Option A — nested rows (tree on the board).**

- **Trigger:** in the chat log (`KLogBlock`), on message hover show a `⑂` icon
  button ("Branch here"). Click → `POST :id/branch` → new child session.
- **Child representation:** a nested child row under the parent in `KTable`,
  with a `└` connector, a `discussion` tag/pill, its own `KStatusDot`, and row
  actions `⤴` (merge) and `✕` (discard). Selecting the row opens the child's
  chat in the same detail panel. `merged` children stay as greyed history rows.
- **Merge modal (`KModal`):** editable `summary` textarea (defaults to A1's last
  assistant text), a preview of where it lands in AAA's chat, a note that AAA
  will act on it and A1 becomes `merged` history; controls `Скасувати` /
  `⤴ Влити в ААА`.
- Palette/idiom: existing tokens (`--k-accent #ff563c` sparingly, square
  corners, mono uppercase eyebrows, glyph icons). Green (`--k-diff`) stays
  diff-only.

## 10. Error handling / edge cases

- Branch when parent has no `ompSessionFile` → `refreshState` then error if
  still none.
- Branch while parent streaming → reject with a clear message.
- `--fork` spawn failure → teardown child, no git.
- `deleteSession(discussion)` must not call any `WorktreeService` git method.
- `doResume(discussion)` must not throw on the branch guard.
- Merge while parent streaming → `follow_up`; dormant parent → resume then
  `prompt`; unresumable parent → error, keep A1.
- Merged discussion child excluded from the in-place single-active guard.
- Parent delete → cascade-discard children.

## 11. Testing

Existing stack: vitest in `packages/core` and `apps/api`.

- **core / registry (unit):** persist + read `parentSessionId`/`kind`; migration
  adds columns idempotently; `createSession` defaults `kind: "agent"`.
- **supervisor (unit, mock `RpcSession` + `WorktreeService`):**
  - `branchSession` creates a `kind: discussion, worktree: false,
    parentSessionId` row; spawns `RpcSession` with `fork`; does **not** call
    `addWorktree`/`createBranchHere`; rehydrates transcript; enforces guards.
  - `mergeDiscussion` calls `sendMessage(parent, wrapped, mode)`; child →
    `merged`; row + file retained.
  - `deleteSession(discussion)` calls **no** `WorktreeService` git method
    (primary safety test).
  - in-place guard ignores discussion; `doResume(discussion)` does not throw.
- **Smoke (manual, the feature's proof):** start API → create session → `⑂`
  branch → one message in A1 → `⤴` merge → summary lands in AAA + A1 `merged`;
  separately branch → `✕` discard → gone, and the project dir has **no** stray
  branch.

## 12. Deferred / future work

- Entry-level branching (icon on a specific past message) — needs omp entry ids
  in the transcript + confirmation the RPC exposes them; add `branch_entry_id`.
- Deeper nested-branch UI beyond one level.
- Optional: keep vs auto-delete merged history as a setting (v1 keeps).
