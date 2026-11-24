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

- Variants — the dev-only prototype route `/#/__design/status-line/variants` (page + fixtures under
  `kermanych/apps/ui/src/pages/design/status-line/`) was deleted once the pipeline shipped; the
  screenshots below are what is left of it. The implementation: `components/kit/KStatusLine.vue`.

## States

`working`, `waiting`, `review`, `failed`, `ready` — `screens/variants-<state>@1280.png`. Today's
screen before the change: `screens/current-in-review@1440.png`. The shipped pipeline:
`screens/implemented-working@1440.png`, `screens/implemented-narrow@1000.png`.

## Decisions

Variant 1, the stage pipeline. Merge-box and pill rejected; see the spec, decision 1.

## Open questions

None.

## Acceptance criteria

See the spec, decisions 2–5.

## Kit gaps

None — the CI / Ревʼю popover is placed by the existing `composables/useAnchoredMenu.ts`.
