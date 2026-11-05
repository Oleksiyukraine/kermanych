// apps/api/src/http/chat-input.ts
// What the chat endpoints (the Менеджмент chat, ЦУК) rebuild out of a browser body before any
// of it reaches a prompt — the pieces both of them receive.
import type { ManagementAttachment, ManagementHomeTodoItem } from "@kermanych/core";
import { badRequest } from "../management/coded-error";

// The operator's files, bounded before a byte lands anywhere. The caps are refusals rather
// than silent drops — a dropped register row is a cosmetic loss, a dropped attachment is
// context the operator is actively relying on, and «відповів без файлу» must never look
// like an answer. 20 MiB of binary is omp's own image cap; base64 puts it at 4/3.
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_B64 = Math.ceil((20 * 1024 * 1024 * 4) / 3);

export function attachmentRows(v: unknown): ManagementAttachment[] {
  if (!Array.isArray(v)) return [];
  if (v.length > MAX_ATTACHMENTS)
    throw badRequest("attachments_too_many", `забагато файлів: ${v.length} (максимум ${MAX_ATTACHMENTS})`, {
      count: v.length,
      max: MAX_ATTACHMENTS,
    });
  const rows: ManagementAttachment[] = [];
  for (const a of v) {
    if (!a || typeof a !== "object") continue;
    const { name, mimeType, data } = a as Record<string, unknown>;
    if (typeof name !== "string" || typeof data !== "string" || typeof mimeType !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed || !data) continue;
    if (data.length > MAX_ATTACHMENT_B64)
      throw badRequest("attachment_too_large", `файл «${trimmed}» завеликий (максимум 20 МіБ)`, { name: trimmed });
    rows.push({ name: trimmed, mimeType, data });
  }
  return rows;
}

// The workspace's «Список дій» as the browser sent it — the Home tile's rows for the
// Менеджмент chat, the notepad's for ЦУК (one list, decision 6 of the ЦУК spec). Same caps as
// the tile's own store; a row with no text is dropped, never repaired.
const MAX_TODO = 200;
const MAX_TODO_TEXT = 500;

export function todoRows(v: unknown): ManagementHomeTodoItem[] {
  const rows: ManagementHomeTodoItem[] = [];
  if (!Array.isArray(v)) return rows;
  for (const t of v.slice(0, MAX_TODO)) {
    if (!t || typeof t !== "object") continue;
    const y = t as Record<string, unknown>;
    if (typeof y.text !== "string") continue;
    rows.push({
      text: y.text.slice(0, MAX_TODO_TEXT),
      kind: y.kind === "number" ? "number" : "check",
      done: y.done === true,
    });
  }
  return rows;
}
