# Notes for coding agents

## UI changes (`apps/ui`)

Every async operation must give visible feedback, and nothing may render an empty state while
its data is still loading. Before you add or change a button, menu item, shortcut,
save-on-change control, modal or data load, read [README → Design → Async states](./README.md#async-states)
and use its primitives (`useAsyncAction`, `useLoadPhase` + `KSkeleton`, `useOptimisticValue`,
`usePending`, the kit's `loading` / `pending` props). Do not hand-roll `busy` flags.
