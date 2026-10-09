# Release notes are always English

## Goal

Every release note — generated from the «Реліз-ноти» form or from the «Менеджмент» chat's
`release.notes` action — is written in English. Ukrainian (or any other language) must not
reach a note through the operator's UI locale, the agent communication language or the
language of the commits.

## Context

Both entry points run one job: `apps/ui/src/stores/release-notes.ts` `run()` →
`POST /management/release-notes` → `ReleaseNotesService.generate` →
`buildReleaseNotesPrompt` → a one-shot child (`runOneShot`).

Before this change three things could make a note Ukrainian:

1. The store sent the UI `locale`; the prompt said «Пиши українською» for `uk`.
2. The service appended the agent-language directive (`languageAppendFor`), which tells the
   model to write every reply in the chosen language — and the child's one reply is the note.
3. The prompt's only language rule was one word in the readability line, while the commits
   printed below it are often Ukrainian; the fallback title was «Реліз-ноти …».

## Decisions

- **English, unconditionally.** No locale or override on the wire. Rejected: keeping
  `locale` and defaulting it to `en` — the UI always sends one, so `uk` operators would
  still get Ukrainian notes.
- **No agent-language append for the generator.** Its directive is about messages to the
  user; this child has none besides the document. Rejected: keeping the append and relying
  on the prompt to outrank a system-prompt instruction.
- **A dedicated language rule in the prompt**, first among the requirements, telling the model
  to translate commits rather than quote them and to keep proper names (people, product,
  interface labels) as they are. Patterned on the ticket protocol's «МОВА ТІКЕТА» rule. The
  prompt body stays a Ukrainian template, like every other prompt in `apps/api/src/management`.
- The fallback title (used only when the model omits the `#` heading) is English.

## Changes

- `packages/core/src/release-notes.ts` — `ReleaseNotesAsk.locale` removed.
- `packages/core/src/i18n-codes.ts` — `Locale` comment no longer names release notes.
- `apps/api/src/management/release-notes-prompt.ts` — `locale` input removed; English rule added.
- `apps/api/src/management/release-notes.service.ts` — no `locale`, no `appendSystemPrompt`,
  English fallback title.
- `apps/api/src/http/management.controller.ts` — stops forwarding `locale`.
- `apps/api/src/management/management-prompt.ts` — `LANGUAGE_NAME` no longer exported.
- `apps/api/src/runtime/resolve-language.ts` — comment lists the call sites that take the append.
- `apps/ui/src/stores/release-notes.ts` — stops sending `locale`.
- Tests: `apps/api/test/release-notes.spec.ts` (English rule replaces the per-locale case),
  `apps/api/test/management-runtime.spec.ts` (the child gets no append even with
  `agentLanguage: "uk"`), `apps/ui/test/release-notes-jobs.spec.ts` (ask has no `locale`).

## Verification

- `pnpm exec vitest run test/release-notes.spec.ts test/management-runtime.spec.ts
  test/management-controller.spec.ts test/management-prompt.spec.ts` in `apps/api` — 76 passed.
- `pnpm exec vitest run test/release-notes-jobs.spec.ts` in `apps/ui` — 6 passed.
- `tsc --noEmit` in `apps/api` and `vue-tsc --noEmit` in `apps/ui`: no errors in the touched
  files. The errors that remain are in other files (`jira.controller.ts`, `src-electron/*`,
  `runtime-messages.spec.ts`).

## Documentation impact

`kermanych/README.md`: «Agent communication language» says the release-notes generator gets no
append, and the chat's release-notes bullet says every note is English.
