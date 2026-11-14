# Чернетки в полях вводу

- **Date:** 2026-11-14
- **Branch:** `feature/persist-input-drafts`
- **Scope:** `apps/ui` (`lib/drafts.ts`, the composers and forms that hold free text, `KSessionCard`,
  i18n `uk` / `en`), `kermanych/README.md` («Design → Drafts»).
- **Status:** asked by the operator on 2026-11-14: «У нас в керманичі є купа інпутів (агенти,
  створення задач...). І часто треба перемикатись між ними. І зараз кожне перемикання повністю
  стирає введення в інпуті… Як референс мені подобається як схожий функціонал реалізований в Slack.»

## Goal

Text the operator typed and did not send must not be lost by switching to something else. Like
Slack's per-channel drafts: the text stays with the place it was typed for, comes back when that
place opens again, survives a restart, and goes away once it is sent. A list shows where a draft
waits.

## Context

- **Agent composer.** `KPanel` held one `draft` ref for whatever session it showed. `AgentsPage`
  reuses one `KPanel` across sessions, so a half-typed message moved with the operator to the next
  agent (and could be sent there). Leaving the route unmounted it and the text was gone.
- **«Нова задача».** `AgentsPage.openLauncher()` and `BoardPage.openCreate()` / `openEdit()` reset
  the title and description on every open. Cancel, then reopen, gave an empty form.
- **Dialogs** (tracker issue editors and ticket dialogs, «Задача з документа», «Синергія» handoff,
  findings, feedback) kept their text in host refs. The text lived until the host unmounted, never
  across a restart. The Jira ticket dialog stays mounted and only its `issue` changes, so a
  half-typed comment showed up on the next ticket.
- **Assistants.** ЦУК and Менеджмент composers kept the text in the component; the Менеджмент
  conversation is per workspace, its text was not.
- Device-local screen state already lives in `localStorage` (`lib/persisted.ts`,
  `useRememberedChoice`).

## Decisions

1. **One store of drafts, keyed by target: `lib/drafts.ts`.** A draft is `{ fields, base, at }`
   under a key such as `session:<id>`, `task-new:<projectId>`, `task:<cardId>`,
   `jira-comment:<integrationId>:<issueKey>`. The forms bind their text refs with
   `useDraft(fields).bind(key, base)` and drop the draft with `discard()` after a save.
   - Rejected: one `persisted()` ref per input. It cannot answer «which agents have a draft» for
     the list mark, and it never forgets a deleted session.
2. **A draft is the difference from what the form opened with (`base`).** Text edited back to
   `base` — sent, saved, erased — removes the draft. A send needs no extra call: the composer
   empties itself.
3. **A card or issue draft is restored only over the text it was typed against.** If the card's
   title or description changed since (a teammate's edit), the stale draft is dropped and the form
   shows the card as it is now.
   - Rejected: restore anyway. The next save would overwrite the teammate's text without a word.
4. **Device-local `localStorage` (`kermanych.drafts`), text only.** Same place as the other screen
   state; nothing in Supabase.
   - Rejected: syncing drafts through the cloud like Slack. It needs a table, RLS and realtime for
     text the operator types on one machine, where the agents run.
   - Images are not kept: base64 of a screenshot is megabytes, past what `localStorage` holds.
5. **«Нова задача» has one draft per project, shared by «Агенти» and «Дошка».** The same thing is
   being written in both forms. A project re-picked inside the board form does not move the draft.
6. **A form opened from a transcript selection («Нова задача з виділеного») keeps no draft.** It is
   prefilled; binding it to the project's «Нова задача» slot would overwrite a draft there.
7. **The ✎ mark.** `KSessionCard` takes `draft`; `AgentsPage` (sessions and backlog cards) and
   `ChatPage` (threads) pass `hasDraft(key)`. The open session shows none: its text is on screen.
8. **Drafts untouched for 30 days are dropped** on load. A deleted session or card leaves no other
   trace that would clear its draft.
9. **The write is synchronous** (`flush: 'sync'`), so a keystroke is stored under the target that
   was bound when it was typed. A form fills its text through `bind(key, base)`, never by assigning
   the refs first: an assignment while still bound to the previous target would be stored as that
   target's draft. Forms that prefill in steps (an async load) call `bind(null)` first.

## Changes

- `apps/ui/src/lib/drafts.ts` — the store, `useDraft`, `hasDraft`, key helpers
  `sessionDraftKey` / `newTaskDraftKey` / `taskDraftKey`.
- `components/kit/KPanel.vue` — the composer text per session (Agents, Chat, Synergy).
- `components/kit/KSessionCard.vue` — the `draft` prop and the ✎ mark; i18n
  `kit.sessionCard.draft`.
- `pages/AgentsPage.vue` — launcher title/task per project (new) or per card (edit); after a save
  the draft is dropped and further edits become the card's; marks on sessions and backlog cards.
- `pages/BoardPage.vue` — the task editor, same keys as the launcher.
- `pages/ChatPage.vue` — marks on threads.
- `components/assistant/AssistantComposer.vue` — `draftKey` prop; `CukAssistant` passes
  `assistant:cuk`, `ManagementAssistant` `assistant:management:<workspaceId>`.
- `components/{jira,linear,plane}/*IssueEditor.vue` — summary/title and description per issue,
  per «new issue» form and per «new sub-task of X» form; an edit binds after the description loads.
- `components/{jira,linear,plane}/*TicketDialog.vue` — the comment per issue; Jira and Plane also
  the note of a new work-log entry per issue (an entry being edited keeps none).
- `components/docs/DocTaskDialog.vue`, `components/synergy/SynergyTaskDialog.vue`,
  `components/agents/SessionFindings.vue` — title/description over their prefill, per document /
  session / finding.
- `stores/feedback.ts` — the feedback message survives a restart.
- `kermanych/README.md` — «Design → Drafts».

## Verification

- `npx vitest run test/drafts.spec.ts` — 5 passed: per-target switching, restart and drop-on-send,
  stale card draft dropped, nothing stored unbound or after `discard()`, 30-day expiry.
- `npx vue-tsc --noEmit` in `apps/ui` — clean.
- Full UI suite `npx vitest run --maxWorkers=4` — 98 files, 1028 tests passed.
- Live preview (`KERMANYCH_SEED=1`), «Агенти», project Acme Web:
  - typed in «Додати онбординг», switched to «Пагінація списку» — its composer was empty, the
    first card showed ✎;
  - reloaded the app — ✎ still there, opening the agent brought the text back;
  - pressed send — the composer emptied and the draft left `localStorage`;
  - «Нова задача»: typed the task, «Скасувати», reopened — task text and derived title restored;
  - ЦУК: typed, reloaded, reopened — text restored.

Not verified:

- «Дошка» task editor: the preview has no cloud project list, so the board's «Нова задача» stays
  disabled there. Covered only by the shared `useDraft` path and typecheck.
- Tracker editors and dialogs (Jira, Linear, Plane), «Задача з документа», «Синергія» handoff,
  findings and feedback: no integrations in the preview; typecheck only.
- Known gaps: in a Jira / Plane edit, text typed into the summary while the description is still
  loading is replaced when the draft binds. A tracker comment send that finishes after the dialog
  switched to another issue clears that issue's draft.

## Documentation impact

`kermanych/README.md` — new «Design → Drafts» section: what keeps a draft, the ✎ mark, storage and
limits, and the `useDraft` rule for new inputs.
