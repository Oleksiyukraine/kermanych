# Status line redo

## Purpose — who uses the screen and for what

The operator glances at «Агенти» to see where each task is and what it waits for. One display of
the task's state, «like GitHub / GitLab», replacing four duplicate status lines.
Spec: `docs/specs/2026-11-25-status-line-pipeline.md`.

## References

- The operator's screenshot (2026-11-25): the same status printed in the card twice, under the tabs
  and over the composer.
- GitLab pipeline graph — taken: stages as connected nodes, each with a state icon; the chosen
  variant.
- GitHub PR merge-box, GitHub «Open / Merged» pill — shown, rejected.

## Screens

- Variants — dev-only route `/#/__design/status-line/variants?state=<state>`, files
  `kermanych/apps/ui/src/pages/design/status-line/` (page + `fixtures.ts`). Deleted after
  implementation.

## States

`working`, `waiting`, `review`, `failed`, `ready` — `screens/variants-<state>@1280.png`. Today's
screen: `screens/current-in-review@1440.png`.

## Decisions

Variant 1, the stage pipeline. Merge-box and pill rejected; see the spec, decision 1.

## Open questions

None.

## Acceptance criteria

See the spec, decisions 2–5.

## Kit gaps

- A popover anchored to an element (the CI / Ревʼю details) — check the kit for an existing one
  before adding.
