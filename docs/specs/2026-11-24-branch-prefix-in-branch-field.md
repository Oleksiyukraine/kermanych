# «Тип» merged into the «Гілка» field of «Нова задача»

## Goal

The «Нова задача» launcher on «Агенти» showed the branch prefix twice: as a segmented «Тип»
picker (`feature | fix | refactoring | chore`) lower in the right column, and as fixed text in
front of the «Гілка» input. The operator asked to pick the prefix where it is read — a dropdown
in place of the fixed prefix — and drop the separate «Тип» section.

## Context

- `kermanych/apps/ui/src/pages/AgentsPage.vue` — the launcher. «Гілка» was a `<label>` box with
  `<span class="agents-launcher__branch-prefix">{{ draftPrefix }}/</span>` and the slug input
  (`draftBranchSlug`, decision 2 of `2026-11-04-custom-branch-name.md`). «Тип» was a block of
  `agents-launcher__seg-btn` buttons over `prefixOptions` (`BRANCH_PREFIXES` minus `synergy`).
- `kermanych/apps/ui/src/components/kit/KSelect.vue` — the app's dropdown: framed trigger,
  teleported glass listbox, ARIA combobox keyboard model, outside-click swallowing inside KModal.

## Decisions

1. **The prefix is a KSelect, in a new `inline` variant.** The trigger is a tinted accent chip
   (`feature ▾`) with no frame of its own, sized to the value it holds; the list, keyboard and
   modal behaviour are KSelect's. Rejected: a hand-rolled menu in AgentsPage (a second dropdown
   convention, and the KModal focus/outside-click handling would have to be redone); a full
   framed KSelect beside the input (a frame inside a frame, and the row no longer reads as one
   branch name).
2. **The field reads in landing order: `[prefix ▾] / slug`.** The slash stays as muted text
   between the chip and the input. The box keeps its frame and focus ring; it is a `<label for>`
   the input, so a click on the padding or the slash puts the caret in the slug, while a click on
   the chip opens the list (a button inside a label keeps its own activation).
3. **No visible caption for the chip.** In the inline variant `label` becomes the trigger's and
   the listbox's `aria-label` — «Тип гілки» / «Branch type» (`agents.launcher.typeLabel`).
4. **The inline chip hugs its value.** The other KSelect forms reserve the widest option's width;
   inside a host field that would leave a gap after `fix`, and the input beside it absorbs the
   width change.
5. **The board's card editor is unchanged.** It has no branch-name field, so its «Тип» select
   stays where it is.

## Changes

- `KSelect.vue`: `inline?: boolean` prop. Hides the caption label (uses it as `aria-label`),
  drops the width sizer, styles the trigger as an accent chip (`.k-select--inline`).
- `AgentsPage.vue`: «Гілка» box hosts `<KSelect inline>` for `draftPrefix`, a slash and the slug
  input (`agents-launcher__branch--prefixed`, height matched to «Оцінка, год»). The «Тип» section
  and `.agents-launcher__branch-prefix` are removed; comments that named «Тип» updated.
- `i18n/{uk,en}`: `agents.launcher.typeLabel` → «Тип гілки» / «Branch type».
- `kermanych/README.md`: the task lifecycle names where the prefix is picked.

## Verification

- `pnpm typecheck` in `kermanych/apps/ui` — passes.
- `vitest run test/members.spec.ts test/menu.spec.ts` — 29 passed.
- Live preview, «Агенти» → «Нова задача», dark and light themes: the «Тип» section is gone; the
  «Гілка» box shows `feature ▾ / згенерується із задачі`; a click on the chip opens the list
  with `feature` ticked; ↓↓ Enter picks `refactoring` and the chip updates; typing «Мій Слаг» shows
  the hint «гілка буде refactoring/mii-slah»; a click on the slash focuses the slug input; the
  trigger's accessible name is «Тип гілки»; the box is the same height as «Оцінка, год».

Not verified: an actual launch with a picked prefix (the value goes through the unchanged
`draftPrefix` → `prefix` save path); a card that stores `synergy` opened in the editor (KSelect
shows a held value outside `options` as its own row, by design).

## Documentation impact

`kermanych/README.md` (task lifecycle, step 4) now says the prefix is picked from the ▾ chip at
the start of «Гілка».
