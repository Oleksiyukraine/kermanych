# Референси в «+ Новий дизайн»

> **Superseded** by `docs/specs/2026-11-09-merge-design-into-synergy.md` (decision 6): the «Дизайн»
> tab and its «Референси» block are gone; in «Синергія» images and links go with a request.

## Goal

When the operator creates a design, they can attach references: images (screenshots, mockups)
and links to sites. The «Дизайнер» receives them and studies them before it builds the screen.

## Context

- The «+ Новий дизайн» modal (`kermanych/apps/ui/src/pages/DesignPage.vue`) asked for a topic,
  a description and a base branch. It filed a `design: true` card and launched it with
  `api.createSessionFromTask(cardId)` without images.
- The api wraps the card in the `DESIGNER` instruction (`packages/core/src/agents.ts`), with the
  topic and the card text as `{{description}}`, and appends the `design-spec` skill
  (`packages/core/src/skills.ts`). `images` of `POST /sessions/from-task` go with that first
  prompt (`supervisor.service.ts` → `rpc.prompt(…, images)`).
- Cards already keep images (`tasks.image_paths`, the `task-images` bucket) and the «Агенти»
  launcher already sends images with a launch, then appends them to the card
  (`board.addTaskImages`).
- The labels «Опис» and «Базова гілка» used `agents.launcher.optional`. Commit `0d840aac` removed
  that key, so the modal showed the raw key `agents.launcher.optional`.

## Decisions

- **Images go the way the «Агенти» launcher sends them.** `useImageAttach`, `KAttachStrip`, paste
  anywhere in the form, drop on the references block, or pick with «⛶ Зображення». The launch sends
  them to the Дизайнер as the first prompt's images. After the session exists, they go on the
  card (best-effort, as in the launcher), so the board and teammates see them.
  - Rejected: write the images into the design folder by the api. That needs a new api path and
    a commit the operator did not ask for. The Дизайнер already sees the images, and the README
    records what it took from them.
- **Links go into the card's description, under `References:`.** `designBrief` in
  `packages/core/src/design.ts` appends them. The Дизайнер, the board card and a relaunch read
  the same text. The heading is English because it is part of the prompt, as the rest of the
  machine-composed prompt is.
  - Rejected: a new `tasks.reference_links` column. It needs a migration, cloud types and a
    second prompt input, and the description already reaches every place that needs the links.
- **A link must be a web address.** `designReferenceLink` accepts `http`/`https` only. A bare
  host gets a scheme: `http://` for `localhost` / `127.0.0.1` (a local dev server), `https://`
  otherwise. It refuses other schemes (`javascript:`, `mailto:`, `ftp:`) and a host without a dot
  (except `localhost`). A typed link that was not added yet is added on «Створити». An invalid
  one stops the create and shows its error line.
- **The Дизайнер is told about references.** `DESIGNER` and `design-spec` ask it to study every
  image and to open every link before it builds, and the README template gets a
  `## References` section.
- **The missing label key is fixed in place.** The modal uses the new `design.new.optional`.

## Changes

- `packages/core/src/design.ts`: `designReferenceLink`, `designBrief`. Exported from the index.
- `packages/core/src/agents.ts` (`DESIGNER`) and `packages/core/src/skills.ts` (`design-spec`):
  the references step and the README section.
- `apps/ui/src/pages/DesignPage.vue`: the «Референси» block (images and links), sends images with
  `createSessionFromTask`, then `board.addTaskImages`. «Створити» is disabled while an image is
  being read.
- `apps/ui/src/i18n/{uk,en}/index.ts`: `design.new.optional|references|image|imageHint|`
  `linkPlaceholder|addLink|linkInvalid|removeLink`. The description placeholder no longer
  mentions links.
- `apps/ui/src/i18n/{uk,en}/agent-about.ts`: the Дизайнер card mentions references.
- `kermanych/README.md`: the «Дизайн» section describes references.

## Verification

- `packages/core/test/design.spec.ts`: link parsing and brief composition.
- `pnpm --filter @kermanych/core test`: 30 files, 356 tests passed.
  `vitest run` in `apps/ui`: 87 files, 949 tests passed (i18n completeness included).
  `vue-tsc --noEmit` in `apps/ui`: clean. Api `sessions.from-task`, `supervisor.native`,
  `supervisor.docs-gate` specs (they render the Дизайнер prompt and the `design-spec` body):
  59 tests passed.
- Browser smoke in the live preview (seeded, no cloud): labels show «необовʼязково» instead of
  the raw key. Images were added by ⛶, drop and paste, and removed with ✕. `javascript:alert(1)`
  showed its error line. `dribbble.com/shots/1` became `https://…` and `localhost:5173/orders` became
  `http://…`. A long link truncates. With the card insert stubbed in the page, «Створити» sent the
  insert with `description: "References:\n- …"` (the typed, not-added link included) and
  `POST /sessions/from-task` with `images: [{ mimeType: "image/png", … }]`. The preview api then
  refused it with `not signed in`, and the modal stayed open with that error.

## Documentation impact

`kermanych/README.md` («Дизайн» → new «References» item, and the README sections of the
folder) describes the references.
