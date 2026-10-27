# Notes for coding agents

## UI changes (`apps/ui`)

Every async operation must give visible feedback, and nothing may render an empty state while
its data is still loading. Before you add or change a button, menu item, shortcut,
save-on-change control, modal or data load, read [README → Design → Async states](./README.md#async-states)
and use its primitives (`useAsyncAction`, `useLoadPhase` + `KSkeleton`, `useOptimisticValue`,
`usePending`, the kit's `loading` / `pending` props). Do not hand-roll `busy` flags.

## Project docs (`project-docs` MCP server)

Specs, plans, runbooks and design mockups are searchable through the `project-docs` MCP server
(docs-harness). Search them before you assume how a feature is meant to behave. Read
[docs/agents/project-docs.md](./docs/agents/project-docs.md) for the tools, the tags to filter
by, and how to re-index.
