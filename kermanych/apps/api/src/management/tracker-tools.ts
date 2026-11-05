// apps/api/src/management/tracker-tools.ts
// What the Менеджмент assistant's tracker tools (jira/jira-tools.service.ts,
// plane/plane-tools.service.ts) share: one call's scope, a tool as tools/list describes it,
// the refusal they answer the model with, the readers that turn the model's JSON arguments
// into values, and the ticket schema both create tools take. Tracker-neutral on purpose —
// both tool sets run on the same MCP endpoint under the same per-child secret, and a reader
// that refused a wrong type differently in each would be two conventions for one model.
import type { Notice } from "@kermanych/core";

// What one call is allowed to touch and where its side effects go. Built per conversation by
// ManagementChatService; the tool layer never learns who is asking any other way.
export type ManagementToolScope = {
  userId: string;
  workspaceId: string;
  // A file the operator attached to this conversation, by the exact name the turn listed it
  // under — the only bytes a create / add-attachment tool may upload.
  file(name: string): { path: string; mimeType: string } | undefined;
  // Where a download tool writes, so the read tool can open what it fetched.
  downloadDir: string;
  // One line per write, in order — the reply's `trackerChanges`.
  changed(notice: Notice): void;
};

// A tool as MCP's tools/list describes it.
export type ManagementToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
};

// A refusal phrased for the model: shown to it verbatim as the tool's error result.
export class ToolError extends Error {}

export type ToolArgs = Record<string, unknown>;

// A download tool writes the bytes where the read tool can open them; past this a file is not
// something a chat turn reads, and the model is told so instead of the disk filling up.
export const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

// ── argument readers ─────────────────────────────────────────────────────────
// MCP arguments are JSON the model wrote. Each reader refuses a wrong TYPE in words the model
// can act on; absent stays absent, because «not mentioned» must never clear a field.

export function optText(a: ToolArgs, name: string): string | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`${name} must be a string`);
  return v.trim();
}

export function reqText(a: ToolArgs, name: string): string {
  const v = optText(a, name);
  if (!v) throw new ToolError(`${name} is required`);
  return v;
}

// A list of names. A comma-separated string is accepted too: models write «a, b» where an
// array was asked for, and the intent is unambiguous.
export function optList(a: ToolArgs, name: string): string[] | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  const items = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(items) || items.some((x) => typeof x !== "string"))
    throw new ToolError(`${name} must be a list of strings`);
  return (items as string[]).map((x) => x.trim()).filter((x) => x !== "");
}

export function optInt(a: ToolArgs, name: string, min: number, max: number): number | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw new ToolError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function optBool(a: ToolArgs, name: string): boolean | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`${name} must be true or false`);
  return v;
}

export function optObject(a: ToolArgs, name: string): Record<string, unknown> | undefined {
  const v = a[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ToolError(`${name} must be a JSON object`);
  return v as Record<string, unknown>;
}

// ── value shaping ────────────────────────────────────────────────────────────

// Drops the keys whose value says nothing, so a row is only what the issue actually carries.
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

// ── the catalogue's building blocks ──────────────────────────────────────────

export const str = (description: string) => ({ type: "string", description });
export const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });
export const int = (description: string) => ({ type: "integer", description });
export const bool = (description: string) => ({ type: "boolean", description });
export const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

// The ticket in the product's five slots — the same object `ticket.create` carries on the
// native board, so a ticket reads the same whichever board it landed on.
export const TICKET_SCHEMA = {
  type: "object",
  description:
    "The ticket in the product's five slots; the description is rendered from them (## Context, ## User flow, ## Acceptance criteria as checkboxes, ## Out of scope). No open questions, TBDs or code.",
  properties: {
    title: str("One line, ≤120 characters — the issue summary."),
    context: str("Why this work exists and for whom, in business terms."),
    userFlow: strs("Optional user-visible steps."),
    acceptanceCriteria: strs("At least one checkable statement."),
    outOfScope: strs("Optional: what this ticket deliberately does not cover."),
  },
  required: ["title", "context", "acceptanceCriteria"],
};
