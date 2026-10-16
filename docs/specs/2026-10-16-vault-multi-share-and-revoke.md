# Storage vault: share with several members at once, and take a share back

- **Date:** 2026-10-16
- **Branch:** `fix/secret-share-and-access-remove`

## Goal

Two fixes to the «Storage» (password vault) management section:

1. The «Share» dialog picks one member at a time. It must take several members in one pick.
2. A password's owner sees who can read the password but cannot take access away. The owner must
   be able to remove the access they shared with a specific member.

## Context

- Screen: `kermanych/apps/ui/src/pages/ManagementStoragePage.vue` — the share dialog is a
  single-select `KSelect` (`shareTo: string`), and the holders column only draws faces.
- Store: `apps/ui/src/stores/passwords.ts` `share(workspaceId, passwordId, userId)`.
- Cloud: `packages/cloud/src/passwords.ts` `sharePassword` → rpc `share_password(uuid, uuid)`
  (`supabase/migrations/20260928100000_workspace_password_share.sql`). A share is an
  `approved` row in `workspace_password_access`; `can_read_password_secret`, the
  `password-files` read policy and `list_password_holders` all read that ledger.
- The ledger has no INSERT/UPDATE/DELETE grant; its rpcs are its only writers. Nothing could
  remove an approved row short of deleting the password.
- `list_password_holders` returns who may read each password (workspace owner, managers,
  approved grants) but not WHY, and a developer-filer's RLS shows only their own ledger rows,
  so the client could not tell a revocable grant from a seat.

## Decisions

- **One atomic rpc for a multi-share:** `share_password_with_members(p_password_id, p_user_ids
  uuid[])` runs `share_password` for each distinct id in one transaction and returns the
  approved rows. Either every member gets the password or none does, and the dialog reports one
  error. Rejected: a client-side loop of `share_password` — a refusal in the middle leaves a
  half-applied share the dialog cannot describe. `share_password(uuid, uuid)` stays for builds
  that predate this one.
- **Revoke deletes the grant row:** `revoke_password_access(p_password_id, p_user_id)` deletes
  the member's `approved` ledger row. The member is back to «no access» and may request again.
  Rejected: flipping it to `declined` — the member never asked, so «declined» would be a lie on
  their screen.
- **Same authority as sharing:** `can_share_password` — the password's filer while still a
  member, the workspace owner or a manager. The owner can take back any grant on their password,
  including one a manager approved from a request.
- **Only grants are revocable.** The workspace owner and managers read every password through
  their seat; removing their access is a role change in the members panel, not a vault action.
  The rpc refuses when there is no approved row.
- **`list_password_holders` gains `via`** (`owner` | `manager` | `grant`), the seat the person
  reads through. It is how the dialog knows which rows get a «Remove access» button. Changing
  the return type needs `drop function` + `create`; older clients ignore the extra column.
- **Where:** the share dialog lists everyone with access («People with access»), each with
  their seat, and a «Remove access» button on shared grants. No confirm: a removed share is
  given back by sharing again.
- **Multi-select:** the existing `KSelect multiple` mode. `KSelect` in `searchable` mode now
  shows the `summary` of a multi-select in its closed field (it showed nothing before; no
  existing caller combined the two modes).

## Changes

- DB: `supabase/migrations/20261016100000_workspace_password_revoke.sql` —
  `share_password_with_members`, `revoke_password_access`, `list_password_holders` + `via`.
- Cloud: `sharePassword(client, passwordId, userIds[])` → `WorkspacePasswordAccess[]` through
  the new rpc; new `revokePasswordAccess(client, passwordId, userId)`; `PasswordHolder.via`
  (`PasswordHolderVia`).
- Store: `share(workspaceId, passwordId, userIds[])`; new `revoke(workspaceId, passwordId,
  userId)` — drops the ledger row and the holder locally, then re-reads holders (also after a
  refusal, so a grant that is already gone stops being offered).
- UI: share dialog — multi-select picker, «People with access» list with seat tags and
  «Remove access»; the dialog's dismiss button reads «Close» (it is no longer only a share
  form); `KSelect` searchable + multiple caption; i18n en/uk.

## Verification

- Migration, against a throwaway Postgres 17 cluster with a stub of the Supabase pieces it
  uses (`auth.uid()` from a GUC, `profiles`, `workspaces`, `workspace_members`,
  `is_workspace_member`, `can_manage_workspace_passwords`, the vault tables), after the old
  `list_password_holders` and `20260928100000_workspace_password_share.sql`:
  - the filer (a developer) shares with `[A, B, A]` → two approved rows;
  - `[C, outsider]` → `a password can only be shared with a workspace member`, and C has no row
    (all or nothing); `[]` → `pick at least one member to share with`;
  - `list_password_holders` → owner `owner`, manager `manager`, A and B `grant`; an outsider
    gets 0 rows;
  - a developer who is not the filer revoking A → refused; the filer revoking A → A's row gone,
    B's kept; revoking A again, the manager (a seat), or C's pending request → `this member has
    no shared access to remove`; a manager revoking B (shared by the filer) → ok;
  - `anon` cannot execute the three functions, `authenticated` can.
- UI, in the dev server (`VITE_KERMANYCH_PREVIEW=1`, no cloud) with the workspace, roster and
  vault seeded into Pinia and `auth.client.rpc` replaced by an in-page fake, signed in as a
  developer who filed the password: the 👥 dialog lists owner / manager / shared rows with
  «Remove access» only on the shared one; the picker offers only members without access, ticks
  bob and carol in one visit and shows «bob, carol» when closed; «Share» sends one
  `share_password_with_members` with `["u-b","u-c"]`, the toast names both and the holder count
  goes 3 → 5; «Remove access» on bob sends `revoke_password_access` for `u-b`, bob leaves the
  list and returns to the picker, the dialog stays open; a refused revoke shows the message
  inline. «Share» is disabled with nothing picked.
- `pnpm --filter @kermanych/ui typecheck` — the only error is the pre-existing one in
  `test/runtime-messages.spec.ts`. `pnpm --filter @kermanych/cloud test` and
  `pnpm --filter @kermanych/ui test` pass.

## Documentation impact

`kermanych/README.md` — new «Sharing a password in Storage» subsection under the Менеджмент
tab: multi-member sharing, «People with access», removing a share, and the migration to push
before shipping the UI.
