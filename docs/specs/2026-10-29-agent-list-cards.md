# Agent list cards: steady height, a ring on every working agent, spend behind an icon

- **Branch:** `feature/improve-agent-list-cards`
- **Scope:** `apps/ui` only — `components/kit/KSessionCard.vue`, `components/kit/KIcon.vue`
  (new `coins` glyph), `pages/AgentsPage.vue` (backlog card preview), a new `lib` helper for the
  description preview with its unit test, `kermanych/README.md`.
- **Builds on / amends:** `docs/specs/2026-10-28-hermes-theme-and-depth.md`, decision 6 (the
  running ring on the selected card).

## Goal

Three complaints about the agent list (operator):

1. The card's height changes while the agent works. The status line flips between the
   in-progress todo (often two lines) and the current tool (one line), and the list jumps.
2. A working agent that is not selected is hard to tell from a finished or waiting one. The
   status dot is there, but the eye does not catch it. Only the selected card wears the
   running ring.
3. Tokens and cost take a whole row. Hide them behind an icon with a tooltip, move the status
   into the freed space, and make the card shorter.

Added during the interview: tidy up the «Задачі» tab, where a backlog card prints its whole
markdown description (headings, checkboxes, code spans) as one tall paragraph.

## Context

- `KSessionCard.vue` renders four rows: name + time, branch, status (`KStatusDot` + status line,
  unbounded wrap), and the accounting row (`KHarnessMark`, «аналіз» / «посіпака» / decision
  marks, model, `N ток · $X`). Users: «Агенти» (sessions and the «Задачі» backlog cards),
  the «Чати» thread list, the kit gallery. `AgentMap.vue` has its own card markup.
- Session status line: `cardLine` in `AgentsPage.vue:2677` (slot wait → current tool →
  in-progress todo → status word). Backlog status line: the raw `item.card.description`.
- At the 300px minimum column width the card has about 244px of content. The model is already
  clipped to `cl…` there.
- The ring: `--selected` draws a masked 1px gradient frame (`::after`). `--running`
  (`selected && isRunningStatus`) animates a conic arc via the registered `--k-ring-angle`.
  Hermes decision 6 rejected animating every running card («a garland»).
- `isRunningStatus` (`lib/attention.ts:108`) = `queued | thinking | tool`. Besides the ring it
  defines the `running` attention level for the sidebar and the project switcher marks.
  `KStatusDot` pulses only for `thinking | tool`; `queued` is a cold grey dot.
- `v-tip` is a plain-text bubble, max 280px wide. `v-tip.overflow` shows only while the target
  is actually clipped.

## Decisions

1. **Three rows; the status joins the accounting row and leads it.**
   ```
   Назва задачі…                         щойно
   feature/branch-name
   ● API: expand helpers in a la…   >_ [аналіз] ¤
   ```
   The status (dot + line) is on the left, one line, ellipsised, and takes the free width. Then
   the harness mark and the «аналіз» / «посіпака» / decision / not-needed marks, then the `¤`
   icon. The row is always present (the dot always is), so a card's height depends only on
   whether it has a branch row, never on what the agent is doing.
   *Rejected:* model before the status (`>_ [marks] model · ● status… ¤`): the status gets even
   less room and loses the place the eye reads first; four rows with a one-line status (no
   height gain); four rows with two lines always reserved (taller cards).

2. **Backlog cards use the same layout, with a cleaned-up preview.** The description shows as
   one ellipsised line, rendered as plain text: heading lines dropped; list, checkbox and
   blockquote markers, code-fence lines, backticks, `**` / `__` and link syntax (`[text](url)` →
   `text`) removed; whitespace collapsed. A card with no description keeps the dot and the
   marks only. The full text is one click away in the launcher. The operator delegated the
   details of this part («сильно не заморочуйся»).
   *Rejected:* a separate multi-line description row for backlog cards (two layouts in one
   component, and long descriptions keep inflating the list); a two-line clamp.

3. **The full status line in a tooltip, only when clipped** (`v-tip.overflow` on the line). Its
   text is capped at 200 characters with «…», so a long backlog description cannot open a
   screen-tall bubble.

4. **Every working card wears the running ring: quieter than the selected one, and in phase.**
   A working card that is not selected gets the masked frame and the travelling arc at roughly
   half the selected card's intensity, with no surface fill. The selected card keeps the full
   ring and the fill, so the two never read alike. All arcs share one phase: the animation is
   pinned to the document timeline (a negative `animation-delay` derived from the timeline
   clock when the card starts working), so N rings turn as one rhythm instead of out of step.
   That is the «garland» Hermes decision 6 feared. Under `prefers-reduced-motion: reduce` every
   ring is a static frame. Hermes decision 6 is amended accordingly.
   *Rejected:* the selected card's exact animation on every working card (only the fill would
   tell the selected one apart, and unsynced arcs are the garland); a static frame without
   motion (the operator asked for the animation).

5. **Only working agents get a frame.** `waiting_input`, `error`, `conflict` and `in_review`
   keep their dot and their place at the top of «Агенти» (agents-tab spec, decision 6), with no
   coloured frame of their own.
   *Rejected:* a static warning / danger frame for agents that need a human (operator's choice).

6. **«Working» means `thinking` or `tool`, for the selected card too.** `queued` (launch, or
   waiting for an agent slot under `slotWait`) no longer runs the arc. An agent waiting an hour
   for a slot must not look busy, and the ring now agrees with the dot's pulse. The card gets
   its own check. `isRunningStatus` stays as it is, because the attention marks rely on it.
   *Rejected:* keeping `isRunningStatus` for the ring.

7. **Spend behind a `coins` icon; the model goes with it.** A drawn `KIcon` glyph `coins`
   (Lucide geometry, like the other glyphs) at the end of the row, in `--k-faint`, lighter on
   hover. Its one-line tooltip uses the format the row had: `claude-opus-5-5 · 4.2M ток · $2.31`
   (`tokens` / `usd` from `lib/format.ts`; a missing field drops out with its separator). The
   same text is its `aria-label`. The icon shows when the model or the usage is known, and is
   absent otherwise, as the row was.
   *Rejected:* an `info` glyph (does not say money lives there); a multi-line breakdown
   (input / output / cache) in the tooltip (`v-tip` is one-line, and the session panel already
   has the breakdown).

8. **The agent map is out of scope; «Чати» follows the card.** `AgentMap.vue` keeps its own
   card, its spend row and its breathing frame. The «Чати» thread list uses `KSessionCard`, so
   it gets the new row (`● … >_ ¤`) and the ring while a chat thinks.
   *Rejected:* bringing the map to the same look in this task (graph node layout changes, a
   separate task if wanted); moving only the map's spend behind the icon.

## Implementation notes

- `KSessionCard.vue`: the status row and the meta row merge into one `__row`: status block
  (`flex: 1; min-width: 0`, the line `white-space: nowrap; text-overflow: ellipsis`), marks
  (`flex: none`), the `coins` span. The `model` / `spend` spans and their styles go. The
  `--running` class keys off a local `working` computed (`thinking | tool`) and no longer needs
  `selected`. The frame (`::after`) is drawn for `--selected` or `--running`; a non-selected
  running card dims it. The phase delay is a CSS variable set when `working` turns true.
- `KIcon.vue`: `coins` added to `KIconName` and the path table.
- `AgentsPage.vue`: the backlog card passes the preview of `item.card.description`.
- New `lib` helper (plain-text one-line preview of a markdown description) + unit test.
- `isRunningStatus` and `lib/attention.ts` unchanged.

## Out of scope

- `AgentMap.vue` cards.
- Card ordering, tabs, search (`2026-10-29-agents-tab-and-focus-mode.md`).
- What the status line says (`cardLine` stays as it is); only how it is laid out.

## Verification

- **Unit (`apps/ui/test`, vitest, `--maxWorkers=4`):** the preview helper: heading lines
  dropped, checkbox / list markers stripped, inline code and links reduced to their text,
  `snake_case` and `a*b` left intact, whitespace collapsed, empty / whitespace-only input → empty.
- `pnpm --filter @kermanych/ui typecheck`; the existing suite stays green.
- **Live check in the running app:** at 300px column width, a working agent's card keeps its
  height while the line flips between todo and tool; several working agents show in-phase
  rings, dimmer than the selected one; a `queued` / `waiting_input` / `done` card has no
  running ring; the `coins` tooltip shows model · tokens · cost; a clipped status shows its
  tooltip and a short one does not; the «Задачі» tab shows one clean line per card; the «Чати»
  thread list renders; reduced motion → static frames.

## Documentation impact

- `kermanych/README.md`, the «Агенти» tabs section (after `:323`): one paragraph on what a card
  shows. The status is on one line (full text on hover). Model, tokens and cost are under the
  coins icon. A running ring marks every agent that is working, the selected one brightest.
- `docs/specs/2026-10-28-hermes-theme-and-depth.md`, decision 6: a pointer to this document
  (every working card now has a ring; `queued` no longer runs it).
