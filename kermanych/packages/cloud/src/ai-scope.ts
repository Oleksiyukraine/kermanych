// The owner axis shared by every «ШІ-команда» table. Storage is a nullable triad
// (workspace_id, project_id, user_id) with a CHECK that exactly one is set; the domain shape
// is a discriminated { scope, id }. These helpers are the one place that crosses between them.
import type { AiOwner, AiScope } from "./types";

// The DB column that holds the owner id for a scope.
const COLUMN = {
  workspace: "workspace_id",
  project: "project_id",
  user: "user_id",
} as const satisfies Record<AiScope, string>;

export type AiOwnerColumn = (typeof COLUMN)[AiScope];

export function ownerColumn(scope: AiScope): AiOwnerColumn {
  return COLUMN[scope];
}

// The three owner columns for an insert: the owner's own carries its id, the other two null.
export function ownerColumns(owner: AiOwner): {
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
} {
  return {
    workspace_id: owner.scope === "workspace" ? owner.id : null,
    project_id: owner.scope === "project" ? owner.id : null,
    user_id: owner.scope === "user" ? owner.id : null,
  };
}

// The owner a row carries, read back from its triad. Throws on the all-null row the CHECK
// already forbids — a corrupt row must not silently read as some default scope.
export function rowOwner(row: {
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
}): AiOwner {
  if (row.workspace_id) return { scope: "workspace", id: row.workspace_id };
  if (row.project_id) return { scope: "project", id: row.project_id };
  if (row.user_id) return { scope: "user", id: row.user_id };
  throw new Error("ai-team row has no owner");
}

// onConflict target for the owner-triad unique constraints (NULLS NOT DISTINCT). The natural
// key columns follow the triad, e.g. `ownerConflict("name")` → the ai_skills_owner_name key.
export function ownerConflict(...natural: string[]): string {
  return ["workspace_id", "project_id", "user_id", ...natural].join(",");
}

// The owner triad, as selected from any ai-team table.
export const OWNER_COLUMNS = "workspace_id, project_id, user_id";
