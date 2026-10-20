# `rpc-session.compact.spec.ts`: ignore the subagent subscription frame

## Goal

The api suite is red: two of three tests in `kermanych/apps/api/test/rpc-session.compact.spec.ts`
fail on any branch. The fake omp records a `set_subagent_subscription` frame (`id: "subagent_sub"`)
before the `compact` frame, so `toHaveLength(1)` and `sent[0]` fail:

```
× compact() sends the bare command frame and resolves once acknowledged
× compact(instructions) forwards them as customInstructions
AssertionError: expected [ { id: 'subagent_sub', …(2) }, …(1) ] to have a length of 1 but got 2
```

Reproduced on 2026-10-20 with
`pnpm -r --filter './packages/**' build && cd apps/api && npx vitest run test/rpc-session.compact.spec.ts`.

## Context

- The frame is intentional. `apps/api/src/rpc/rpc-session.ts:88-98` sends `negotiate_protocol` on
  `ready`. Unless `subagentSubscription` is `"off"`, it then sends `set_subagent_subscription` with
  the level `"progress"`. The subagent agent map needs this frame (commit `0c3f520`).
- `test/rpc-session.subagents.spec.ts:74-77,110` checks this contract: the frame comes after
  `negotiate_protocol` with level `"progress"`, and it is absent when the subscription is `"off"`.
- `test/rpc-session.thinking.spec.ts:37` already handles the frame. Its fake omp skips both
  `negotiate_protocol` and `set_subagent_subscription`. The compact spec still skips only
  `negotiate_protocol` (line 35), which is why it fails.
- The same failures are recorded as unrelated in `2026-09-30-documentation-settings.md` and
  `2026-10-08-agent-language-ste.md`.

## Decision

In the compact spec's `fakeOmp`, skip `set_subagent_subscription` the same way as
`negotiate_protocol`. This copies `rpc-session.thinking.spec.ts:37`. Keep the current assertions.
`toHaveLength(1)` still catches any extra frame that `compact()` itself sends.

Production code does not change.

## Rejected alternatives

- **Create `RpcSession` with `subagentSubscription: "off"`.** The test would stop exercising the
  default start path, and any new startup frame would break it again.
- **Find the frame with `sent.find(f => f.type === "compact")` and drop `toHaveLength(1)`.** The
  test would no longer detect extra frames sent by `compact()`.
- **Remove the frame from `RpcSession.start()`.** The subagent map depends on it, and
  `rpc-session.subagents.spec.ts` asserts it.

## Verification

- `npx vitest run test/rpc-session.compact.spec.ts` in `kermanych/apps/api`: 3/3 pass.
- `pnpm --filter @kermanych/api test`: no failures in `rpc-session.compact.spec.ts`.

## Documentation

Not needed. The change affects only a test and changes no command, endpoint, config key or flow.
