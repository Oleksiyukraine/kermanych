# i18n Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-locale (`uk` base + `en`) i18n layer to the Kermanych app, migrating ~2,700 hard-coded Ukrainian strings across 95 files to a message catalog, with the server boundary localized by string owner.

**Architecture:** vue-i18n in `apps/ui`, locale as a device preference (mirrors `lib/theme.ts`). Approach C (hybrid by string owner): `packages/core` pure display functions return keys; `apps/api` notices + HTTP errors carry `{ code, params }` on the wire and the UI renders them; model-facing prompt text stays server-side with the locale passed in. `session.name` is left as-is.

**Tech Stack:** Vue 3 + Quasar 2, TypeScript, vue-i18n (v9/v10 matching the app's Vue minor), NestJS (api), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-i18n-design.md` — read it alongside this plan.

## Global Constraints

- Locales: `uk` (base, source of truth, fallback) + `en`. No third locale, no per-account locale.
- `uk` catalog is the message **schema**: a missing `en` key MUST be a type error, not a runtime fallback.
- Locale is device-local: `localStorage` key `kermanych.locale`, default `uk`. Never persisted to Supabase.
- `session.name` is NOT changed (server keeps writing Ukrainian prose). Explicit non-goal.
- Every wire code (`NoticeCode`, `ApiErrorCode`) keeps the server `text`/message as a fallback; a missing/unknown code degrades to Ukrainian prose, never to a blank or a bare code.
- Key naming: `<domain>.<screen-or-group>.<element>` (e.g. `agents.launcher.title`, `kit.composer.send`, `risk.categories.technical`).
- Migrated `.vue`/registry files MUST contain no remaining Cyrillic string literals (enforced by the Phase 5 lint gate).
- Do NOT run the full build/lint/test suite per task; validation is one gate at the end (Phase 5). Per-task tests run only the task's own spec.
- Follow existing patterns (`lib/theme.ts`, existing Vitest specs). No unrelated refactoring.

---

## File Structure

**New files:**
- `apps/ui/src/boot/i18n.ts` — creates + installs the vue-i18n instance.
- `apps/ui/src/lib/locale.ts` — device-preference store (mirror of `lib/theme.ts`).
- `apps/ui/src/i18n/uk/index.ts` + `apps/ui/src/i18n/uk/{common,agents,board,settings,management,risk,kit,chat,errors,notices}.ts`
- `apps/ui/src/i18n/en/…` — same shape as `uk`.
- `apps/ui/src/i18n/schema.ts` — the message-schema type derived from `uk`.
- `apps/ui/src/components/kit/KLangToggle.vue` — the language switcher (or inline in the settings pane).
- `packages/core/src/i18n-codes.ts` — `NoticeCode`, `ApiErrorCode` unions.
- `apps/ui/test/locale.spec.ts`, `apps/ui/test/i18n-completeness.spec.ts`.

**Modified (by area — exact per-file lists in the tasks):**
- core: `types.ts` (notice variant), `tool-display.ts`, `chat-blocks.ts`, `agents.ts`, `management.ts`, `index.ts` (exports).
- api: `management.controller.ts`, `release-notes.service.ts`, `management-chat.service.ts`, `supervisor.service.ts` (notice codes only), `management/management-prompt.ts`, `management/release-notes-prompt.ts`.
- ui renderers of core/api output: `components/kit/KRequestBlock.vue`, `KLogBlock.vue`, `KPanel.vue`, `lib/api.ts` (error mapping), the toast helper.
- ui copy: all 95 files with Ukrainian literals (Phase 3).

---

## Phase 1 — Foundation (serial; everything else depends on it)

### Task 1: Install vue-i18n and the boot instance

**Files:**
- Modify: `apps/ui/package.json` (add `vue-i18n`)
- Create: `apps/ui/src/boot/i18n.ts`
- Create: `apps/ui/src/i18n/uk/index.ts`, `apps/ui/src/i18n/en/index.ts`, `apps/ui/src/i18n/schema.ts`
- Modify: `apps/ui/quasar.config.ts` (boot array)

**Interfaces:**
- Produces: `apps/ui/src/boot/i18n.ts` default-exports the Quasar boot fn and a named `i18n` instance whose `global.locale` is settable; `MessageSchema` type from `schema.ts`; empty-but-typed `uk`/`en` message objects.

- [ ] **Step 1: Add the dependency**

Run: `cd apps/ui && pnpm add vue-i18n` (pin the major that matches the installed Vue 3 minor; verify `pnpm why vue` first).

- [ ] **Step 2: Create the uk catalog aggregator (empty domains)**

`apps/ui/src/i18n/uk/index.ts`:
```ts
// uk is the source of truth and the message SCHEMA. Domains are split into
// files so each is reviewable on its own; add keys here as domains migrate.
export const uk = {
  common: {},
  agents: {},
  board: {},
  settings: {},
  management: {},
  risk: {},
  kit: {},
  chat: {},
  errors: {},
  notices: {},
} as const;
```

- [ ] **Step 3: Derive the schema type**

`apps/ui/src/i18n/schema.ts`:
```ts
import type { uk } from './uk';
// The shape every locale must satisfy. `en` is checked against this, so a
// dropped key is a compile error, not a silent runtime fallback.
export type MessageSchema = typeof uk;
```

- [ ] **Step 4: Create the en catalog typed against the schema**

`apps/ui/src/i18n/en/index.ts`:
```ts
import type { MessageSchema } from '../schema';
export const en: MessageSchema = {
  common: {}, agents: {}, board: {}, settings: {}, management: {},
  risk: {}, kit: {}, chat: {}, errors: {}, notices: {},
};
```

- [ ] **Step 5: Create the boot file**

`apps/ui/src/boot/i18n.ts`:
```ts
import { boot } from 'quasar/wrappers';
import { createI18n } from 'vue-i18n';
import { uk } from '../i18n/uk';
import { en } from '../i18n/en';
import type { MessageSchema } from '../i18n/schema';
import { readLocale } from '../lib/locale';

export const i18n = createI18n<[MessageSchema], 'uk' | 'en'>({
  legacy: false,
  locale: readLocale(),
  fallbackLocale: 'uk',
  messages: { uk, en },
});

export default boot(({ app }) => {
  app.use(i18n);
});
```

- [ ] **Step 6: Register the boot in quasar.config**

Modify `apps/ui/quasar.config.ts`: boot array `['tokens', 'tip', 'supabase']` → `['tokens', 'i18n', 'tip', 'supabase']`.

- [ ] **Step 7: Verify it builds**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS (note: `readLocale` lands in Task 2; if executing strictly in order, stub `readLocale = () => 'uk'` inline here and replace the import in Task 2). 

- [ ] **Step 8: Commit**

```bash
git add apps/ui/package.json apps/ui/src/boot/i18n.ts apps/ui/src/i18n apps/ui/quasar.config.ts pnpm-lock.yaml
git commit -m "feat(ui): scaffold vue-i18n boot + uk/en catalogs"
```

### Task 2: Locale device-preference store

**Files:**
- Create: `apps/ui/src/lib/locale.ts`
- Test: `apps/ui/test/locale.spec.ts`
- Reference pattern: `apps/ui/src/lib/theme.ts` (read it first)

**Interfaces:**
- Produces: `type Locale = 'uk' | 'en'`; `readLocale(): Locale`; `writeLocale(l: Locale): void`; `locale: Ref<Locale>`; `initLocale(i18n): void` (watches `locale`, writes through and sets `i18n.global.locale`). Consumed by `boot/i18n.ts` (Task 1) and `KLangToggle` (Task 4).

- [ ] **Step 1: Write the failing test**

`apps/ui/test/locale.spec.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readLocale, writeLocale } from '../src/lib/locale';

beforeEach(() => localStorage.clear());

describe('locale store', () => {
  it('defaults to uk when nothing is stored', () => {
    expect(readLocale()).toBe('uk');
  });
  it('round-trips a written locale through localStorage', () => {
    writeLocale('en');
    expect(readLocale()).toBe('en');
    expect(localStorage.getItem('kermanych.locale')).toBe('en');
  });
  it('falls back to uk for an unknown stored value', () => {
    localStorage.setItem('kermanych.locale', 'fr');
    expect(readLocale()).toBe('uk');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @kermanych/ui test locale`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/locale.ts`** (mirror `theme.ts`)

```ts
import { ref, watch, type Ref } from 'vue';
import type { I18n } from 'vue-i18n';

export type Locale = 'uk' | 'en';
const KEY = 'kermanych.locale';
const LOCALES: readonly Locale[] = ['uk', 'en'];

export function readLocale(): Locale {
  const v = localStorage.getItem(KEY);
  return (LOCALES as readonly string[]).includes(v ?? '') ? (v as Locale) : 'uk';
}
export function writeLocale(l: Locale): void {
  localStorage.setItem(KEY, l);
}
export const locale: Ref<Locale> = ref(readLocale());
export function initLocale(i18n: I18n<Record<string, unknown>, {}, {}, string, false>): void {
  watch(locale, (l) => {
    writeLocale(l);
    i18n.global.locale.value = l;
  }, { immediate: true });
}
```

- [ ] **Step 4: Wire `initLocale` into the boot** — in `boot/i18n.ts` call `initLocale(i18n)` inside the boot fn; replace any Task-1 stub import with the real `readLocale`.

- [ ] **Step 5: Run tests, confirm pass**

Run: `pnpm --filter @kermanych/ui test locale`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/locale.ts apps/ui/test/locale.spec.ts apps/ui/src/boot/i18n.ts
git commit -m "feat(ui): locale device-preference store mirroring theme"
```

### Task 3: en-completeness gate

**Files:**
- Test: `apps/ui/test/i18n-completeness.spec.ts`

**Interfaces:**
- Consumes: `uk`, `en` from `src/i18n/*`.

- [ ] **Step 1: Write the test** (deep key-set equality)

`apps/ui/test/i18n-completeness.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';

function keys(o: unknown, prefix = ''): string[] {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      keys(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

describe('i18n completeness', () => {
  it('en has exactly the uk key set', () => {
    expect(keys(en).sort()).toEqual(keys(uk).sort());
  });
});
```

- [ ] **Step 2: Run it, confirm pass** (both empty now).

Run: `pnpm --filter @kermanych/ui test i18n-completeness`
Expected: PASS. This test now guards every later migration.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/test/i18n-completeness.spec.ts
git commit -m "test(ui): en-completeness gate against the uk schema"
```

### Task 4: Language switcher in Settings → app-general

**Files:**
- Create: `apps/ui/src/components/kit/KLangToggle.vue`
- Modify: `apps/ui/src/pages/SettingsPage.vue` (the `app-general` pane, beside the theme toggle)
- Reference: how the theme toggle is rendered in `SettingsPage.vue` (read it first)

**Interfaces:**
- Consumes: `locale` ref from `lib/locale.ts`.

- [ ] **Step 1: Build `KLangToggle.vue`** — a two-option segmented control bound to `locale` (`Українська` / `English`), matching the theme toggle's markup/класси. Its two option labels are the ONE place a language name appears in its own language, so they are literals, not keys.

```vue
<template>
  <div class="k-lang-toggle" role="group" aria-label="Мова / Language">
    <button type="button" :class="{ 'k-lang-toggle__opt--active': locale === 'uk' }"
      class="k-lang-toggle__opt" @click="locale = 'uk'">Українська</button>
    <button type="button" :class="{ 'k-lang-toggle__opt--active': locale === 'en' }"
      class="k-lang-toggle__opt" @click="locale = 'en'">English</button>
  </div>
</template>
<script setup lang="ts">
import { locale } from '../../lib/locale';
</script>
```
(Add scoped styles matching the theme toggle.)

- [ ] **Step 2: Place it in the `app-general` pane** next to the theme control in `SettingsPage.vue`, with a label via `t('settings.appGeneral.language')` (add that key to `uk`/`en` `settings` domain).

- [ ] **Step 3: Manual smoke** — deferred to Phase 5 (needs the dev server). Note the check: toggling flips `<html>`/UI language live and persists across reload.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/kit/KLangToggle.vue apps/ui/src/pages/SettingsPage.vue apps/ui/src/i18n
git commit -m "feat(ui): language switcher in app-general settings"
```

### Task 5: Wire contracts — NoticeCode + ApiErrorCode + notice variant

**Files:**
- Create: `packages/core/src/i18n-codes.ts`
- Modify: `packages/core/src/types.ts:122-131` (the `TranscriptEntry` notice variant)
- Modify: `packages/core/src/index.ts` (export the new module)
- Test: `packages/core/test/i18n-codes.spec.ts`

**Interfaces:**
- Produces: `type NoticeCode` (union of the ~12-15 notice identifiers), `type ApiErrorCode` (union of the ~9-14 error identifiers), each with a `params` contract; the notice variant gains `code?: NoticeCode; params?: Record<string, string>`. Consumed by every Phase 2 api task and the UI renderers.

- [ ] **Step 1: Define the code unions** (names enumerated from the spec's inventory; keep `params` keys documented inline)

`packages/core/src/i18n-codes.ts`:
```ts
// Stable identifiers for server-produced prose the UI localizes. The server
// still sends human `text` as a fallback; these let the UI re-render in the
// user's locale. Extend by adding a member AND its uk/en `notices.*`/`errors.*`
// message — the exhaustiveness test below fails otherwise.
export type NoticeCode =
  | 'chat_reset'
  | 'omp_launch_timeout'
  | 'interactive_request_cancelled'
  | 'omp_exited_during_reply'
  | 'assistant_no_reply_timeout'
  | 'frames_lost'
  | 'skill_added_by_trigger'
  | 'not_carried_to_worktree';
export type ApiErrorCode =
  | 'conversation_id_missing'
  | 'message_empty'
  | 'workspace_missing'
  | 'section_context_missing'
  | 'project_missing'
  | 'branch_missing'
  | 'period_format_invalid'
  | 'period_start_after_end'
  | 'project_not_in_registry'
  | 'project_not_bound'
  | 'branch_not_in_repo'
  | 'no_commits_in_range'
  | 'omp_launch_timeout'
  | 'generation_timeout';
export const NOTICE_CODES: readonly NoticeCode[] = [
  'chat_reset', 'omp_launch_timeout', 'interactive_request_cancelled',
  'omp_exited_during_reply', 'assistant_no_reply_timeout', 'frames_lost',
  'skill_added_by_trigger', 'not_carried_to_worktree',
];
export const API_ERROR_CODES: readonly ApiErrorCode[] = [
  'conversation_id_missing', 'message_empty', 'workspace_missing',
  'section_context_missing', 'project_missing', 'branch_missing',
  'period_format_invalid', 'period_start_after_end', 'project_not_in_registry',
  'project_not_bound', 'branch_not_in_repo', 'no_commits_in_range',
  'omp_launch_timeout', 'generation_timeout',
];
```
> Note for the executor: reconcile this list against the live producers (spec §Architecture / scope map). If a producer has no member, add one here first; if a member has no producer, remove it. The lists and the union MUST agree.

- [ ] **Step 2: Extend the notice variant**

Modify `packages/core/src/types.ts` notice line to:
```ts
  | { kind: "notice"; id: string; at: number; level: "info" | "warn" | "error"; text: string; code?: import("./i18n-codes").NoticeCode; params?: Record<string, string> }
```

- [ ] **Step 3: Export from the barrel** — add `export * from "./i18n-codes";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Exhaustiveness test**

`packages/core/test/i18n-codes.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { NOTICE_CODES, API_ERROR_CODES } from '../src/i18n-codes';
describe('i18n codes', () => {
  it('arrays have no duplicates', () => {
    expect(new Set(NOTICE_CODES).size).toBe(NOTICE_CODES.length);
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});
```

- [ ] **Step 5: Build core + run test**

Run: `pnpm --filter @kermanych/core build && pnpm --filter @kermanych/core test i18n-codes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/i18n-codes.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/test/i18n-codes.spec.ts
git commit -m "feat(core): i18n wire codes + notice code/params variant"
```

---

## Phase 2 — Server boundary (parallel after Phase 1; one owner per file)

Each task: change the string owner to emit keys/codes, update its unit test to assert the key/code (not prose), add the matching `uk`/`en` messages, and update the UI renderer. Add every new key to BOTH catalogs (the completeness test enforces it).

### Task 6: core `tool-display.ts` → stat keys

**Files:**
- Modify: `packages/core/src/tool-display.ts` (stat strings ~lines 65/95/113)
- Modify: `packages/core/test/tool-display.spec.ts`
- Modify UI renderers: `apps/ui/src/components/kit/KRequestBlock.vue`, `KLogBlock.vue`
- Messages: `apps/ui/src/i18n/{uk,en}/kit.ts`

**Interfaces:**
- Produces: `toolDisplay(...)` returns `{ ...unchanged, stat?: { key: 'tool.stat.dir' | 'tool.stat.files' | 'tool.stat.matches'; params?: Record<string, string|number> } }` instead of a Ukrainian `stat: string`.

- [ ] **Step 1** — read `tool-display.ts` + its spec; identify the three stat producers (`каталог`; `${n} файлів[·обрізано]`; `${m} збігів / ${f} ф`).
- [ ] **Step 2 (test first)** — update `tool-display.spec.ts` cases to assert `stat.key`/`stat.params` (e.g. `expect(d.stat).toEqual({ key: 'tool.stat.files', params: { count: 3, truncated: false } })`). Run: `pnpm --filter @kermanych/core test tool-display` → FAIL.
- [ ] **Step 3** — change the three producers to return the structured `stat`. Run the test → PASS.
- [ ] **Step 4** — add `kit.toolStat.{dir,files,matches}` messages to `uk` (verbatim current prose) + `en`. Update `KRequestBlock.vue`/`KLogBlock.vue` to render `t(stat.key, stat.params)`.
- [ ] **Step 5** — build core. Commit: `feat(core): tool-display stats as i18n keys`.

### Task 7: core `chat-blocks.ts` → unit keys

**Files:** `packages/core/src/chat-blocks.ts`, `packages/core/test/chat-blocks.spec.ts` (if present), messages `i18n/{uk,en}/chat.ts`, renderer `KLogBlock.vue`.
- [ ] **Steps** — same TDD shape: the per-tool count units (`ln`/`збігів`/`файлів`) become keys `chat.unit.{lines,matches,files}`; test asserts the key; UI renders via `t()`. Add uk/en messages. Build + commit: `feat(core): chat-block units as i18n keys`.

### Task 8: core `agents.ts` label → labelKey

**Files:** `packages/core/src/agents.ts`, `packages/core/test/*agents*`, renderer `apps/ui/src/**/AgentSkillsPanel.vue` (and any other reader of `AgentDef.label`), messages `i18n/{uk,en}/agents.ts`.
- [ ] **Steps** — rename `AgentDef.label` → `labelKey: 'agents.role.<id>'` (6: review/promote/pull-request/resolve-conflict/finish/summary). English `instruction` templates untouched. Test asserts `labelKey`. UI renders `t(labelKey)`. Add uk (verbatim) + en messages. Build + commit: `feat(core): agent labels as i18n keys`.

### Task 9: core `management.ts` hints/limitations → keys

**Files:** `packages/core/src/management.ts`, renderer `apps/ui/src/pages/ManagementPage.vue`, messages `i18n/{uk,en}/management.ts`.
- [ ] **Steps** — `MANAGEMENT_SECTIONS[].hint`/`.limitation` become `hintKey`/`limitationKey`. UI nav renders `t(hintKey)`. NOTE: the prompt (Task 12) reads the Ukrainian variant regardless of UI locale — keep the raw uk strings reachable server-side (see Task 12). Test asserts keys. Build + commit: `feat(core): management section hints as i18n keys`.

### Task 10: api notices → codes

**Files:** `apps/api/src/management/management-chat.service.ts` (7 notices), `apps/api/src/supervisor/supervisor.service.ts` (notice entries), messages `i18n/{uk,en}/notices.ts`, renderer path `apps/ui/src/lib/chat-blocks`/`KLogBlock.vue`/`KPanel.vue`, test `apps/api/test/*`.
- [ ] **Steps** — each notice producer sets `code: <NoticeCode>` + `params` and keeps `text` (uk) as fallback. Add a test asserting the emitted `code`+`params`. UI: when a notice has `code`, render `t('notices.'+code, params)`, else `text`. Add uk/en `notices.*` messages. Build core+api, run the api test. Commit: `feat(api): transcript notices carry i18n codes`.

### Task 11: api HTTP errors → codes

**Files:** `apps/api/src/http/management.controller.ts` (5), `apps/api/src/management/release-notes.service.ts` (4+timeouts), `management-chat.service.ts` (timeouts), messages `i18n/{uk,en}/errors.ts`, UI `apps/ui/src/lib/api.ts` + toast helper, test `apps/api/test/*`.
- [ ] **Steps** — throw exceptions whose body carries `{ code: <ApiErrorCode>, params }` (keep the Ukrainian message as fallback). Test asserts the response `code`. UI api client maps `code`→`t('errors.'+code, params)` for the toast, falling back to the server message. Add uk/en `errors.*`. Build + test. Commit: `feat(api): HTTP errors carry i18n codes`.

### Task 12: prompt locale threading

**Files:** `apps/api/src/management/management-prompt.ts`, `apps/api/src/management/release-notes-prompt.ts`, their callers (`management-chat.service.ts`, `release-notes.service.ts`), request DTOs, UI callers that send the request.
- [ ] **Steps** — thread the user's `locale` from the UI request into `buildManagementPrompt`/release-notes prompt so the model is told which language to answer in (rule ґ already says "user's language, default uk"). The prompt text stays Ukrainian templates; only the "answer in X" directive is parameterized. No i18n catalog for these. Add a test that the prompt includes the locale directive. Commit: `feat(api): thread UI locale into model prompts`.

---

## Phase 3 — UI copy migration (parallel after Phase 1; one owner per file)

### Migration procedure (applies to EVERY task below)

For each file in the task's area:
1. Read the file. For every Ukrainian (Cyrillic) user-facing literal — template text, `label`/`placeholder`/`title`/`v-tip` bindings, `aria-label`, notify/toast strings, and registry data fields — choose a key `<domain>.<screen>.<element>`.
2. Add the key with the **verbatim current uk string** to the matching `apps/ui/src/i18n/uk/<domain>.ts`, and an English translation to `apps/ui/src/i18n/en/<domain>.ts`. Interpolations use vue-i18n named params (`t('x.y', { name })`), plurals use vue-i18n plural syntax.
3. Replace the literal: templates → `{{ t('key') }}` / `:label="t('key')"`; `<script setup>` → `const { t } = useI18n()` then `t('key')`; registry files → store the key string, render at the callsite via `t()`.
4. Leave no Cyrillic literal in the file (comments may stay Ukrainian).

**Worked example — `apps/ui/src/components/kit/KComposer.vue`:**
- `Хелпери` → `kit.composer.helpers`; `Додати зображення` → `kit.composer.addImage`; `Модель` → `kit.composer.model`; `Рівень роздумів` → `kit.composer.effort`; placeholder `напиши наступний крок…` → `kit.composer.placeholder`.
- `i18n/uk/kit.ts`: `composer: { helpers: 'Хелпери', addImage: 'Додати зображення', model: 'Модель', effort: 'Рівень роздумів', placeholder: 'напиши наступний крок…' }`
- `i18n/en/kit.ts`: `composer: { helpers: 'Helpers', addImage: 'Attach image', model: 'Model', effort: 'Reasoning effort', placeholder: 'write the next step…' }`
- Template: `v-tip="'Хелпери'"` → `v-tip="t('kit.composer.helpers')"`; `placeholder="напиши…"` → `:placeholder="t('kit.composer.placeholder')"`. Add `const { t } = useI18n();`.

Each Phase-3 task ends with: `pnpm --filter @kermanych/ui typecheck` for the touched files passing, `pnpm --filter @kermanych/ui test i18n-completeness` passing, and a commit `feat(ui): localize <area>`.

### Tasks (by area — file lists from the scope map; assign one owner each)

- [ ] **Task 13: `components/kit` batch A** — KComposer.vue, KPanel.vue, KDiffView.vue, KDateField.vue (domain `kit`).
- [ ] **Task 14: `components/kit` batch B** — KFileView.vue, KEnvEditor.vue, KDirPicker.vue + the remaining ~30 kit components (domain `kit`). Split into two owners if large.
- [ ] **Task 15: `AgentsPage.vue`** (~180 strings, domain `agents`).
- [ ] **Task 16: `SettingsPage.vue`** (~220 strings, domain `settings`) — includes the `app-general` label added in Task 4.
- [ ] **Task 17: `BoardPage.vue`** (~140 strings, domain `board`).
- [ ] **Task 18: `ManagementPage.vue` + ManagementRisksPage + ManagementReleasesPage** (~260 strings, domain `management`) — consumes the `hintKey`s from Task 9.
- [ ] **Task 19: `KitGalleryPage.vue`** (~95 strings, domain `kit`/`common` — showcase labels).
- [ ] **Task 20: `ChatPage.vue`, `LoginPage.vue`, `ErrorNotFound.vue`** (domains `chat`/`common`).
- [ ] **Task 21: `layouts/MainLayout.vue` + `AuthLayout.vue`** (~65 strings, domain `common`).
- [ ] **Task 22: `lib/settings.ts` registry** — `SETTINGS_SCOPES`, `SETTINGS_CATEGORIES` `{label,sub,blurb}`, `AGENT_KIND_LABELS` → keys (`settings.categories.<key>.{label,sub,blurb}` etc.); update every callsite to render via `t()`. Update `apps/ui/test` if a settings spec asserts prose → assert key.
- [ ] **Task 23: `lib/risk.ts` registry** — anchors, bands, categories, kinds, responses, statuses, event/proximity labels → `risk.*` keys; helpers return keys; callers render via `t()`; risk specs assert keys.
- [ ] **Task 24: `composables/` + `stores/` + remaining `lib/` (`time.ts`, `calendar.ts`, `menu.ts`, `format.ts`)** — ~120 strings; date/number/plural words move to vue-i18n `Intl`/plural helpers where applicable, otherwise keys under `common`.

---

## Phase 4 — English review + completeness (serial, last)

### Task 25: en translation review gate
- [ ] **Step 1** — Run `pnpm --filter @kermanych/ui test i18n-completeness` — every uk key has an en key.
- [ ] **Step 2** — Present the full `en` catalog (all domains) to the user for review; the copy is authorial, so `en` is *written*, not machine-translated. Apply requested wording changes.
- [ ] **Step 3** — Commit any en edits: `docs(i18n): en copy review pass`.

---

## Phase 5 — Validation gate (serial, last)

### Task 26: full validation + visual smoke
- [ ] **Step 1: No-Cyrillic lint** — grep migrated `.vue`/registry files for Cyrillic string literals (excluding comments); expected: none in template/label positions. Fix stragglers.
- [ ] **Step 2: Build + typecheck** — `for P in core cloud api; do pnpm --filter @kermanych/$P build; done && pnpm --filter @kermanych/ui typecheck`. Expected: exit 0.
- [ ] **Step 3: Tests** — `for P in core cloud ui api; do pnpm --filter @kermanych/$P test; done`. Expected: all green (incl. completeness + code tests).
- [ ] **Step 4: Visual smoke** — dev server (`PORT=<free> pnpm --filter @kermanych/ui dev`), temporarily make `/kit` public, verify: (a) KLangToggle flips UI language live and persists across reload; (b) a migrated screen renders in both `uk` and `en`; (c) a tool-call row shows a localized stat. Revert the temporary route toggle. Stop the server.
- [ ] **Step 5: Commit** any fixes. Push the branch and open the PR against `dev`.

---

## Self-Review

**Spec coverage:** infra (Tasks 1-4) ✓; wire contracts (Task 5) ✓; core string owners tool-display/chat-blocks/agents/management (Tasks 6-9) ✓; api notices/errors/prompt (Tasks 10-12) ✓; UI copy incl. data registries settings.ts/risk.ts (Tasks 13-24) ✓; session.name non-goal (untouched) ✓; en review (Task 25) ✓; testing + visual smoke (Task 26) ✓; decomposition ordering (foundation → parallel boundary+migration → en → validate) matches spec §Decomposition ✓.

**Placeholder scan:** the code-count lists in Task 5 carry an explicit reconcile-against-producers instruction (not a placeholder — a named verification step); migration tasks reference the fully-specified procedure + worked example rather than restating per-file code (a 95-file mechanical migration; the procedure is the DRY spec). No TBD/TODO left.

**Type consistency:** `NoticeCode`/`ApiErrorCode` (Task 5) are consumed verbatim by Tasks 10-11; `stat: { key, params }` (Task 6) matches its `KRequestBlock`/`KLogBlock` renderers; `labelKey`/`hintKey` (Tasks 8-9) match their renderers; `locale`/`readLocale` (Task 2) match boot (Task 1) and KLangToggle (Task 4).
