# Plan: drafts in input fields

Spec: `docs/specs/2026-11-14-persist-input-drafts.md`.

## Steps

- [x] **1. The draft store.** `apps/ui/src/lib/drafts.ts` (`useDraft`, `hasDraft`, key helpers).
  *Verify:* `apps/ui/test/drafts.spec.ts`.
- [x] **2. Agent composer per session.** `components/kit/KPanel.vue`.
  *Verify:* preview — type, switch agent, reload, send.
- [x] **3. «Нова задача» and card edit.** `pages/AgentsPage.vue` (launcher), `pages/BoardPage.vue`
  (editor). *Verify:* preview — type, cancel, reopen; typecheck for the board.
- [x] **4. The ✎ mark.** `components/kit/KSessionCard.vue`, `pages/AgentsPage.vue`,
  `pages/ChatPage.vue`, i18n `uk` / `en`. *Verify:* preview screenshot.
- [x] **5. Assistants.** `components/assistant/AssistantComposer.vue`, `CukAssistant.vue`,
  `components/management/ManagementAssistant.vue`. *Verify:* preview — ЦУК across a reload.
- [x] **6. Tracker forms.** `components/{jira,linear,plane}/*IssueEditor.vue`, `*TicketDialog.vue`.
  *Verify:* `vue-tsc --noEmit`.
- [x] **7. Other dialogs.** `components/docs/DocTaskDialog.vue`,
  `components/synergy/SynergyTaskDialog.vue`, `components/agents/SessionFindings.vue`,
  `stores/feedback.ts`. *Verify:* `vue-tsc --noEmit`.
- [x] **8. Docs.** `kermanych/README.md` «Design → Drafts», the spec, this plan.

## Risks and order

- No migration and no flag: the store is new `localStorage` state, read once at start.
- Step 1 first; every other step only calls it. A form must set its opening text through
  `bind(key, base)`, never by assigning the refs first (spec, decision 9).
