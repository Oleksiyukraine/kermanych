# «English — ASD-STE100»: Simplified Technical English as an agent communication language

## Goal

The operator asked (session `add-new-language`, 2026-10-08) to add ASD-STE100 to «Мова спілкування
агента», after [Andrej Karpathy's post](https://x.com/karpathy/status/2105819303471976479).
Karpathy asks LLMs to explain things in ASD-STE100, a controlled English made for aerospace
maintenance documentation, because he finds the result more readable. He sometimes softens it
to "80% of the way to ASD-STE100" because the full standard is strict. The operator wants the
standard in the language list in three levels. The settings page must also explain what the
standard is and what each level enforces.

## Context

- **Vocabulary.** `packages/core/src/language.ts` holds `AGENT_LANGUAGES` (ten codes),
  `AGENT_LANGUAGE_LABELS` (endonyms, which do not change with the app locale) and
  `agentLanguageDirective()`, which returns "Always communicate with the user in X (endonym)…".
  The directive governs conversation only and says nothing about files.
- **Storage.** The cloud column `profiles.agent_language` is free `text` with no check
  constraint (`20260909100000_profile_agent_language.sql`). The local cache is
  `auth_session.agent_language` in SQLite, hydrated on sign-in by `AuthService.setToken`. The
  other places that read or write the value are `GET/POST /account/language`, the cloud helpers
  `get/setMyAgentLanguage`, the UI store's `auth.chooseLanguage`, and the picker in
  `SettingsPage.vue` («ШІ-провайдер» pane). Every reader validates the value with
  `isAgentLanguage`, and an unknown value degrades to "no preference".
- **Reach.** `languageAppendFor()` (`apps/api/src/runtime/resolve-language.ts`; the env var
  `KERMANYCH_LANGUAGE` beats the cache) builds the system-prompt append for:
  - every managed spawn in `SupervisorService.systemAppendOpts`: agents, chats, discussions,
    reviews, forks, scouts, resumes;
  - the «Менеджмент» chat;
  - release notes.

  omp receives the append as `--append-system-prompt`, claude as `systemPrompt.append`. Native
  sessions and the Slack bot get nothing.
- **The standard.** ASD-STE100 Issue 9 (January 2025) has 53 writing rules in nine sections:
  words, multi-word nouns, verbs, sentences, procedural writing, descriptive writing, safety
  instructions, punctuation and word count, writing practices. It also has a dictionary of
  about 900 approved words, and it exists for English only. The document is ASD's copyright:
  "no reproduction or publication of it, in whole or in part, shall be made without the written
  authority of an officer of ASD".

## Decisions

- **STE is an agent language: three more entries in the same list**, placed right after
  «English»:
  - «English — ASD-STE100»
  - «English — ASD-STE100 (80%)»
  - «English — ASD-STE100 (60%)»

  «Українська» and «English» stay separate entries. Rejected: a separate «стиль відповідей»
  setting that combines with any language. The operator chose one list and one choice. Also
  rejected: a free-text custom-instructions field, which is another feature.
- **The labels name the real standard plus a percentage.** Rejected: «ASD-STE80» and
  «ASD-STE60». "100" is the specification's number, not a percentage, and no STE80 or STE60
  exists. A teammate would search for a standard that does not exist, and the model cannot know
  one. The percentage is Karpathy's own phrasing.
- **Codes:** `en-ste`, `en-ste-80`, `en-ste-60`, appended to `AGENT_LANGUAGES` after `en`. They
  are internal identifiers. Nothing reads them as BCP 47 tags.
- **The levels are defined explicitly, not left to the model.** The directive applies to every
  reply in every managed session, so its behaviour must be the same across models and runtimes,
  and "60%" has no established meaning. Rejected: a bare "write 80% of the way to ASD-STE100".
  The matrix:

  | Rule | 100 | 80% | 60% |
  |---|---|---|---|
  | `dictionary`: only STE dictionary words, each in its one approved meaning (technical terms and identifiers allowed) | on | — | — |
  | `grammar`: STE verb forms only, `-ing` only inside a technical noun, no contractions or Latin abbreviations | on | — | — |
  | `length`: at most 20 words in an instruction, 25 in a description | on | on | soft: a guide, not a limit |
  | `instructions`: one instruction per sentence, imperative, condition first, steps as a numbered list | on | on | on |
  | `active`: active voice, an action as a verb and not a noun | on | on | on |
  | `terms`: one term for one thing, no synonyms in the same text | on | on | on |
  | `phrasing`: no phrasal verbs, at most three nouns in a row, no semicolons | on | on | — |
  | `paragraphs`: one topic, at most six sentences, the main point first | on | on | soft: one topic, no sentence limit |
  | `safety`: WARNING or CAUTION and the risk before a step that can lose data or cause damage | on | on | — |

- **One matrix in core drives both the directive and the page.** A new module
  `packages/core/src/ste.ts` holds the rules. Each rule has an id, its English instruction, an
  optional softened instruction, and a mode per level (`on`, `soft` or `off`). The settings page
  renders its table from the same matrix, so the explanation cannot drift from what the agent
  receives. The page's rule labels live in i18n, keyed by a `Record<SteRuleId, …>`, so a missing
  label fails the typecheck.
- **Guard rails at every level, stated above every rule:**
  - keep every fact, number, condition, exception and scope limit;
  - keep the confidence of the source;
  - add no facts;
  - quote code, identifiers, paths, commands, error messages and interface labels exactly.
- **The rules apply only to the agent's messages to the operator:** explanations, summaries,
  questions and status updates. Files in the repository, commits, pull requests, code comments,
  tickets and release notes follow the project's conventions and their own instructions, and
  the directive says so. Rejected: also applying the rules to repository documents, or to all
  natural-language output. The language is a personal profile setting, but the team reads the
  documentation, and the project's «Документація» settings govern it. STE documentation would
  be a project setting.
- **The rules are paraphrased; nothing is copied from the specification** (ASD copyright). Models
  know the standard. Level 100 tells the model to apply the full standard, dictionary included,
  "as you know it".
- **The explanation sits on the page, always visible**, under the language select and separated
  by the pane's rule line. Rejected: a collapsed block, or a block shown only when an STE level is
  selected. The table is needed before the choice.
- **Unchanged:**
  - the select's note («Нові сесії відповідатимуть цією мовою…»);
  - the preference stays per user;
  - `KERMANYCH_LANGUAGE` accepts the new codes through the same guard;
  - native sessions get nothing.

  No migration is needed because the column is free text. An older build on another machine of
  the same user reads an STE code as "no preference": its picker shows "—", and its API keeps the
  previously cached language, because `setToken` writes only a valid value.
- **Out of scope:** the «Менеджмент» chat's contract names the UI locale (rule ґ «Відповідай …
  мовою»), and the release-notes prompt names its own language. When the agent language differs,
  both instructions reach the model. This is true today for every language, and it stays as it
  is.

### The directive

`agentLanguageDirective()` returns this for `en-ste-80`. The rule list is generated from the
matrix, and the line above the list changes with the level.

```text
Always communicate with the user in English, regardless of the language of the codebase, files, or earlier messages.
Write your messages to the user (explanations, summaries, questions, and status updates) 80% of the way to ASD-STE100 Simplified Technical English. Apply only these rules, not the full standard:
- Write no more than 20 words in an instruction and no more than 25 words in a description. A number, an identifier, a path, or a command counts as one word.
- Write one instruction in each sentence, in the imperative. Put a condition first: "If X, do Y". Write a sequence of steps as a numbered list.
- Use the active voice and say who or what does the action. Use a verb for an action, not a noun: "check the log", not "perform a check of the log".
- Use one term for one thing, with one meaning. Do not change to a synonym later in the text.
- Use a single verb, not a phrasal verb: "start", not "spin up". Put no more than three nouns in a row. Do not use semicolons. Write two sentences instead.
- Give each paragraph one topic and no more than six sentences. Put the most important point first.
- Before a step that can lose data or cause damage, such as `rm -rf` or `git reset --hard`, write WARNING or CAUTION, then the instruction, then the risk.
These rules apply only to your messages to the user. Text that you write into files, commits, pull requests, code comments, tickets, or release notes follows the project's conventions and the task's instructions.
Above every rule:
- Keep every fact, number, condition, exception, and scope limit. Write a longer sentence or two sentences rather than drop one.
- Keep the confidence of the source: "may fail" stays "may fail".
- Add no facts.
- Quote code, identifiers, file paths, commands, error messages, and interface labels exactly as they are.
Do not mention these rules unless the user asks about them.
```

- **`en-ste` (100):**
  - The line above the list reads "…in ASD-STE100 Simplified Technical English. Apply the full
    standard as you know it, including its dictionary. In particular:".
  - The list adds `dictionary`: "Use only words that the STE dictionary approves, each in its one
    approved meaning and part of speech. Technical nouns and verbs of the subject (commit,
    branch, deploy) and code identifiers are permitted."
  - The list adds `grammar`: "Use only the verb forms that STE permits: infinitive, imperative,
    simple present, simple past, simple future, and the past participle as an adjective. Use
    the -ing form only in a technical noun. Do not use contractions or Latin abbreviations."
- **`en-ste-60`:**
  - The line above the list reads "60% of the way to…".
  - `length` softens to "Prefer short sentences: about 20 words in an instruction and 25 in a
    description. Write a longer sentence when a split would lose clarity."
  - `paragraphs` softens to "Give each paragraph one topic. Put the most important point
    first."
  - `phrasing` and `safety` are dropped.

### The block on the page

Ukrainian copy (English mirrors it), under the select in the «ШІ-провайдер» pane:

- **Title:** «ASD-STE100 — спрощена технічна англійська».
- **Text:** «ASD-STE100 Simplified Technical English — стандарт контрольованої англійської,
  створений для документації з обслуговування літаків. Його веде асоціація ASD, чинна редакція —
  Issue 9 (січень 2025). Короткі речення, одна дія в реченні й одне значення для кожного терміна
  роблять текст швидким для читання. Стандарт існує лише для англійської, тому з цим вибором
  агент відповідає англійською. Повний стандарт суворий, тож є м'якші рівні — 80% і 60%.»
- **Table** (`KTable`): «Правило · 100 · 80% · 60%». A cell shows ✓, — or the softened wording
  («орієнтир», «одна тема, без ліміту»).
- **Guard rails:** «На всіх рівнях агент не губить фактів, чисел, умов і винятків, не змінює
  ступінь упевненості й не додає фактів від себе. Код, шляхи, команди, тексти помилок і підписи
  інтерфейсу він наводить дослівно.»
- **Scope:** «Правила діють лише на повідомлення вам. Файли, коміти, PR, коментарі в коді,
  тікети й реліз-ноти агент пише за правилами проєкту.»
- **Source:** a link «asd-ste100.org ↗» to `https://www.asd-ste100.org/`, opened in the OS
  browser through the app's existing `target="_blank"` routing.

## Changes

- **Core:**
  - new `ste.ts` with the rule matrix, the level per code, and the STE directive builder;
  - `language.ts`: the three codes, their labels and English names; `agentLanguageDirective()`
    routes the STE codes to the builder;
  - exports added in `index.ts`.
- **UI:**
  - a new `components/settings/SteGuide.vue` (text, `KTable`, guard rails, scope, link), mounted
    under the language select in `SettingsPage.vue` after a `set__rule`;
  - `settings.language.ste.*` keys in `i18n/uk` and `i18n/en`.
- **API, cloud, Supabase:** no code change. `isAgentLanguage`, `languageAppendFor`, the account
  controller, the registry and the cloud helpers already go through core.
- **Tests:** in `packages/core`, cases for the matrix → directive invariant:
  - for each level, every `on` rule's instruction appears, every `soft` rule's softened
    instruction appears, and no `off` rule appears;
  - every level carries the scope line and the guard rails;
  - the STE codes pass the guard.

## Verification

To run after implementation:

- `pnpm --filter @kermanych/core test`, `pnpm --filter @kermanych/api test`,
  `pnpm --filter @kermanych/ui test` (including i18n completeness); typecheck `ui` and `api`.
- Smoke, UI: the app from this worktree, Settings → «ШІ-провайдер».
  - The select lists the three entries after «English».
  - The block shows its text, the table and the link.
  - Switching the app locale switches the block's language.
- Smoke, behaviour: a managed chat from this worktree's API with `KERMANYCH_LANGUAGE` set to
  `en-ste`, then `en-ste-80`, then `en-ste-60`, answers the same question. Each reply is checked
  against its level's rules.

## Documentation impact

- `kermanych/README.md`: a new subsection «Agent communication language» after «Runtime
  preference». It covers the per-user preference, its cloud and local storage,
  `KERMANYCH_LANGUAGE`, its reach (managed spawns only), and the three STE levels with their
  scope. It points to this spec.
