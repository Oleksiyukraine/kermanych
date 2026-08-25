# Kermanych v3 — Screens / UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the Phase-2 kit into the v3 information architecture: a top bar (KTopNav: Агенти / Дошка / Чат) over a persistent left sidebar, a three-pane Агенти view, a Kanban Дошка, and a standalone Чат.

**Architecture:** View switching is by route (`/`=Агенти, `/board`=Дошка, `/chat`=Чат) under `MainLayout`. The shell (top bar + sidebar) lives in `MainLayout`; each route renders its middle/right content. The sidebar's bucket nav drives the Агенти filter via a shared store field (`selectedBucket`).

**Tech Stack:** Vue 3 / Quasar (Vite), Pinia, TypeScript; NestJS API; git via `worktree.service`.

**Spec:** `docs/superpowers/specs/2026-08-25-kermanych-v3-redesign-design.md`
**Predecessors (done):** `2026-08-25-kermanych-v3-design-system.md`, `2026-08-25-kermanych-v3-ui-kit.md`

## Global Constraints

- Use kit components + tokens only; no hardcoded colors/radii/spacing.
- Dark-only. Ukrainian UI copy; English code/identifiers.
- Preserve ALL existing behavior/routes/store methods except where a task says to change them. Keep every modal (create/settings/delete project, env, dir-picker, account) and the toast stack.
- Buckets (Агенти): **Активні** = `queued|thinking|tool|waiting_input`, not archived, not backlog · **Задачі** = `backlog` · **Відкладені** = `archived=true` · **Історія** = `merged|done|stopped`, not archived.
- Дошка columns keep the EXISTING mapping (`BoardPage.vue:436-440`): Беклог(backlog)/У черзі(queued)/В роботі(thinking,tool)/Чекає(waiting_input)/Завершені(done,merged,stopped,error,conflict). This is a restyle, not a remap.
- Verify each task: `pnpm --filter @kermanych/ui typecheck` (+ `@kermanych/api` build for T3) and a live check in the running app (browser).

## Task ordering

T1 (shell) → T2 (Агенти) depends on T1's `selectedBucket` + sidebar; T3 (Зміни API) feeds T2's Зміни tab (T2 stubs it, T3 wires it); T4 (Дошка) and T5 (Чат) depend only on T1's nav/route. T4/T5 are independent of T2/T3.

---

## Task T1: Shell / IA — top bar + sidebar (MainLayout)

**Files:**
- Modify: `apps/ui/src/layouts/MainLayout.vue` (template `1-313`, script `315-832`)
- Modify: `apps/ui/src/router/routes.ts:36-42` (add `/chat`)
- Modify: `apps/ui/src/stores/orchestrator.ts` (add `selectedBucket` state + setter)
- Create: `apps/ui/src/pages/ChatPage.vue` (placeholder shell; filled in T5)

**Interfaces (Produces):**
- `orchestrator.selectedBucket: Ref<'active'|'tasks'|'archived'|'history'>` (default `'active'`) + `setBucket(b)`.
- Route name `chat` at path `/chat`.

- [ ] **Step 1:** In `orchestrator.ts`, add `const selectedBucket = ref<'active'|'tasks'|'archived'|'history'>('active')` and `function setBucket(b){ selectedBucket.value = b }`; export both.
- [ ] **Step 2:** In `routes.ts`, add a child after the `board` route: `{ path: 'chat', name: 'chat', component: () => import('pages/ChatPage.vue'), meta: { public: false } }`. Create `ChatPage.vue` as a minimal `<template><main class="chat"/></template>` placeholder (T5 fills it).
- [ ] **Step 3:** Rebuild the `MainLayout` template. Replace `q-layout view="lHh Lpr lFf"` shell:
  - **Top bar** (`q-header`, keep or a plain header div): brand «КЕРМАНИЧ» + `<KTopNav :model-value="topView" :options="topOptions" @update:model-value="goView">` (options: Агенти/Дошка/Чат) + the project-context actions currently at `90-135` (bind/env/settings, `v-if="selectedProjectId"`).
  - **Left sidebar** (`q-drawer`, widen from 60px to ~240px): bucket nav `<KNavItem v-for>` (Активні/Задачі/Відкладені/Історія with `:count` from `bucketCounts` and `:active="selectedBucket===key"`, `@click="onBucket(key)"`); then a «Проєкти» group (the existing `railProjects` as a KNavItem/KRailItem list + KBtn `+`); then a «Тека проєкту» block (context path + «Змінити теку» → `openBinding`); `KUserButton` pinned to the bottom.
  - **Remove** the `q-footer` + `KStatusBar` (`146-150`); bucket counts replace it.
  - Keep `q-page-container` + `<router-view/>` and ALL modals (`151-295`) + `KToast` (`296-313`) unchanged.
- [ ] **Step 4:** Script: add `topView` computed (route name → `'agents'|'board'|'chat'`), `topOptions`, `goView(v)` (router.push to `workspace`/`board`/`chat`), `onBucket(key)` (`store.setBucket(key)`; if route ≠ `workspace`, `router.push({name:'workspace'})`), and `bucketCounts` computed (tally `sessionsOf(selectedProjectId)` into the 4 buckets). Remove `KStatusBar` import + `counts` if now unused by the footer (keep if used elsewhere).
- [ ] **Step 5:** `pnpm --filter @kermanych/ui typecheck` → PASS.
- [ ] **Step 6:** Live: top bar switches Агенти/Дошка/Чат; sidebar shows buckets with counts + projects + тека + user; footer gone. Commit: `git commit -m "feat(ui): v3 shell — top bar nav + sidebar (MainLayout)"`

## Task T2: Агенти — three-pane list + detail tabs (WorkspacePage)

**Files:** Modify `apps/ui/src/pages/WorkspacePage.vue` (template `1-439`, script `440-1982`)

**Interfaces (Consumes):** `orchestrator.selectedBucket` (T1). **Produces:** the Агенти screen.

- [ ] **Step 1:** Buckets. Add `VIEW_HISTORY`; replace `viewMode`/`showArchived`/`showTasks` (`686-693`) with reads of `store.selectedBucket`. Rewrite `projectSessions` (`711-727`) filter per the Global Constraints bucket definitions. Keep `boardRows` (`730-746`) tree logic, fed the filtered subset. Simplify/keep `STATUS_RANK` for in-bucket ordering.
- [ ] **Step 2:** Middle column. Delete the KTable block + its scoped slots + `agentColumns` (`43-198`, `861-868`). Render `<KSessionCard v-for="s in boardRows" :key="s.id" :branch="s.branch" :title="s.name" :time="relativeTime(s.lastActivityAt, now)" :status="s.status" :status-line="activityOf(s) || statusWord(s)" :selected="store.selectedSessionId === s.id" @click="store.selectSession(s.id)" />`. Keep the empty-state and the «Нова задача»/«Швидкий чат» buttons (move into the middle column header).
- [ ] **Step 3:** Right detail. Wrap the existing `KPanel` (`231-405`) in `<KTabs v-model="detailTab" :tabs="[{value:'log',label:'Лог'},{value:'changes',label:'Зміни'},{value:'session',label:'Сесія'}]">`. `log` = the current KPanel + KRequestBlock content. `changes` = a stub for now (`<p>Готую…</p>`; wired in T3). `session` = metadata (model/branch/worktree/base/status/contextPercent/chatCost) + the session action buttons moved out of the old KTable actions slot (`129-196`): finish/review/pr/archive/delete/branch/preview, gated exactly as they were. Persist `detailTab` per session (`localStorage` key `ws.tab.<id>`; default `log`). Keep the resizable seam (`210-229`, `useResizableWidth` `811-835`) and the detail header + close (`343-357`).
- [ ] **Step 4:** `onRowClick` (`1154-1158`): keep the `kind==='task'` → open launcher branch (task cards still edit on click); else `selectSession`.
- [ ] **Step 5:** typecheck → PASS.
- [ ] **Step 6:** Live: pick a project; the middle column lists sessions per the active sidebar bucket; clicking a card opens KPanel on the right under Лог/Зміни/Сесія tabs; composer works. Commit: `git commit -m "feat(ui): v3 Агенти — session-card list + detail tabs"`

## Task T3: Зміни — changed files in finishInfo (API + tab)

**Files:**
- Modify: `apps/api/src/worktree/worktree.service.ts` (add `changedFiles`)
- Modify: `apps/api/src/supervisor/supervisor.service.ts:1076-1085` (`finishInfo` return += `files`)
- Modify: `apps/ui/src/lib/api.ts:204-207` (`finishInfo` return type += `files`)
- Modify: `apps/ui/src/pages/WorkspacePage.vue` (wire the `changes` tab)

**Interfaces (Produces):** `finishInfo(): { branch; target; ahead; dirty; conflicts; files: { path: string; added: number; removed: number }[] }`.

- [ ] **Step 1:** In `worktree.service.ts`, add (mirroring `aheadCount` `63-65`): `async changedFiles(dir, base): Promise<{path:string;added:number;removed:number}[]>` running `git -C <dir> diff --numstat <base>...HEAD`, parsing each `added\tremoved\tpath` line (treat `-` binary counts as 0). Bound output; ignore parse failures → `[]`.
- [ ] **Step 2:** In `supervisor.finishInfo`, call `changedFiles(worktreePath, target)` and add `files` to the returned object.
- [ ] **Step 3:** In `api.ts`, extend the `finishInfo` return type with `files: { path: string; added: number; removed: number }[]`.
- [ ] **Step 4:** In WorkspacePage, on selecting a session or opening the `changes` tab, call `store.finishInfo(id)`; render `ahead` commits, `dirty` flag, `conflicts`, and the `files` list (path mono + `+added −removed` using `--k-diff-add/-diff-del`). Handle the non-worktree / error case gracefully (message, no throw).
- [ ] **Step 5:** `pnpm --filter @kermanych/api build` + `pnpm --filter @kermanych/ui typecheck` → PASS.
- [ ] **Step 6:** Live: the Зміни tab of a worktree agent shows ahead/dirty + changed files. Commit: `git commit -m "feat: changed-files in finishInfo + Зміни tab"`

## Task T4: Дошка — Kanban restyle (BoardPage)

**Files:** Modify `apps/ui/src/pages/BoardPage.vue` (card markup `70-117`, columns loop, `goToWorkspace`)

- [ ] **Step 1:** Replace the per-column wrapper with `<KKanbanColumn :label="col.label" :count="byColumn[col.key].length">` and each `article.board__card` (`70-117`) with `<KKanbanCard :title="task.title" :branch="task.branch" :project="projectName(task)" :time="relativeTime(task.updatedAt, now)" :status="task.status" @click="openEdit(task)">`. Keep the existing `COLUMNS` (`436-440`), `byColumn`/`visibleTasks` computed, the Усі/Цей проєкт filter, offline/outbox alerts, and ALL modals (editor/binding/forceStop/dirPicker).
- [ ] **Step 2:** Preserve card actions: render the existing edit/delete/force-stop/launch controls inside the card (KKanbanCard default slot or a small footer), unchanged handlers (`openEdit`/`onDelete`/`openForceStop`/`launch`). Keep the assignee select + stale badge.
- [ ] **Step 3:** `goToWorkspace` still `router.push({name:'workspace'})`; the top bar handles view switching now.
- [ ] **Step 4:** typecheck → PASS.
- [ ] **Step 5:** Live: `/board` shows the 5 columns as v3 Kanban cards; create/edit/delete/force-stop still work. Commit: `git commit -m "feat(ui): v3 Дошка — Kanban restyle"`

## Task T5: Чат — standalone screen (ChatPage)

**Files:** Modify `apps/ui/src/pages/ChatPage.vue` (created in T1)

**Interfaces (Consumes):** `orchestrator.createChat`, `sendMessage`, `transcripts`, `selectedProjectId`, `selectedSessionId`; kit `KChatMessage`, `KThoughtToggle`, `KComposer`; `buildChatBlocks`.

- [ ] **Step 1:** On mount, ensure a chat session for `selectedProjectId`: reuse the most recent `kind==='chat'` session or `store.createChat(projectId)`; track its id. Guard the no-project case with a blank state.
- [ ] **Step 2:** Render its transcript (`store.transcripts[chatId]` via `buildChatBlocks`): user turns → `<KChatMessage role="user">`, assistant prose → `<KChatMessage role="assistant">` (reuse the markdown render used in KPanel/KLogBlock), reasoning → `<KThoughtToggle>`. Read-only tool rows (read/grep/glob) may render as compact KToolRow as today.
- [ ] **Step 3:** Composer: `<KComposer v-model="draft" :model="chatModel" @send="onSend">` → `store.sendMessage(chatId, text, 'prompt', images)`. Show a «Лише читання» indicator (chats are read-only).
- [ ] **Step 4:** typecheck → PASS.
- [ ] **Step 5:** Live: `/chat` opens a full-width chat; sending a message streams a reply; reasoning collapses. Commit: `git commit -m "feat(ui): v3 Чат — standalone chat screen"`

---

## Self-review

- **Spec coverage:** shell/IA (T1), Агенти 3-pane + Історія + tabs (T2), Зміни summary+files (T3), Дошка kanban (T4), Чат (T5) — the spec's Screens section end-to-end. Skips honored: no costs/tokens, no PRO, no theme toggle, no drag-drop, no full-diff viewer (summary only).
- **No placeholders:** every task has real files, line refs (from the scout maps), and concrete component wiring. The `changes` tab is explicitly stubbed in T2 and wired in T3 (sequenced, not a placeholder).
- **Type consistency:** `selectedBucket` union is identical in T1 (produced) and T2 (consumed); `finishInfo.files` shape is identical in T3's API and UI; KSessionCard/KKanbanCard props match the Phase-2 definitions (`branch/title/time/status/statusLine`, `title/branch/project/time/status`).
- **Deviation (ruled):** Дошка keeps the existing column status mapping (error/stopped in Завершені), not the spec's «error/stopped → Чекає» suggestion — the existing board already ships that mapping; a restyle must not silently change task grouping. Cost if wrong: a follow-up remap, cheap.
