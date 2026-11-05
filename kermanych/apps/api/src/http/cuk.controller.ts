// apps/api/src/http/cuk.controller.ts
// ЦУК («Центр управління Керманича») over REST: one question, one answer. Auto-guarded by
// the global SupabaseAuthGuard (app.module.ts) like the Менеджмент chat, for its reason — the
// console spends the operator's own provider plan. One global conversation per user, so the
// body names none: the key is the guard's user id (spec decision 5).
import { Body, Controller, Post, Req } from "@nestjs/common";
import type {
  CukBoardRow,
  CukChatAsk,
  CukChatReply,
  CukContext,
  CukPlace,
  CukProjectRow,
  CukSessionRow,
  CukWorkspaceRow,
  SessionStatus,
} from "@kermanych/core";
import { CukChatService } from "../cuk/cuk-chat.service";
import { badRequest, relay } from "../management/coded-error";
import { attachmentRows, todoRows } from "./chat-input";

// The digest is rebuilt field by field, never forwarded: every line of it is printed into the
// prompt as the state of the app, and the names in it are what the model's actions address.
// The caps keep a machine with hundreds of sessions from turning each turn into pages of
// text; the browser reports what it cut in `sessionsOmitted` / `boardOmitted`, and what the
// caps here cut on top is added to those counts, so «їх більше» stays honest.
const MAX_SESSIONS = 80;
const MAX_BOARD = 60;
const MAX_PROJECTS = 100;
const MAX_WORKSPACES = 50;
const MAX_PLACES = 80;
const MAX_NAME = 200;
const MAX_REF = 40;

// Complete by construction: a status added to core fails to compile here until it is listed.
const SESSION_STATUS: Record<SessionStatus, true> = {
  backlog: true,
  queued: true,
  thinking: true,
  tool: true,
  waiting_input: true,
  done: true,
  in_review: true,
  error: true,
  stopped: true,
  merged: true,
  conflict: true,
};

function isStatus(v: unknown): v is SessionStatus {
  return typeof v === "string" && Object.hasOwn(SESSION_STATUS, v);
}

function text(v: unknown, max = MAX_NAME): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// Rows of one list, capped, each rebuilt by `row` (undefined = dropped). Returns how many
// rows the cap cut, so the caller can add them to the omitted count.
function rows<T>(v: unknown, max: number, row: (x: Record<string, unknown>) => T | undefined): { rows: T[]; cut: number } {
  if (!Array.isArray(v)) return { rows: [], cut: 0 };
  const out: T[] = [];
  for (const item of v.slice(0, max)) {
    if (!item || typeof item !== "object") continue;
    const r = row(item as Record<string, unknown>);
    if (r !== undefined) out.push(r);
  }
  return { rows: out, cut: Math.max(0, v.length - max) };
}

function workspaceRow(x: Record<string, unknown>): CukWorkspaceRow | undefined {
  const name = text(x.name);
  return name ? { name, role: text(x.role, 40), selected: x.selected === true } : undefined;
}

function projectRow(x: Record<string, unknown>): CukProjectRow | undefined {
  const name = text(x.name);
  return name ? { name, workspace: text(x.workspace), bound: x.bound === true, selected: x.selected === true } : undefined;
}

function sessionRow(x: Record<string, unknown>): CukSessionRow | undefined {
  const ref = text(x.ref, MAX_REF);
  // A row without a ref cannot be addressed by any action; one with a status this build
  // does not know would be printed as a state the app has no meaning for.
  if (!ref || !isStatus(x.status)) return undefined;
  return {
    ref,
    project: text(x.project),
    name: text(x.name),
    kind: text(x.kind, 40),
    status: x.status,
    waiting: x.waiting === true,
    archived: x.archived === true,
    ...(x.preview === true ? { preview: true } : {}),
  };
}

function boardRow(x: Record<string, unknown>): CukBoardRow | undefined {
  const title = text(x.title);
  return title ? { title, project: text(x.project), status: text(x.status, 40), assignee: text(x.assignee) } : undefined;
}

function placeRow(x: Record<string, unknown>): CukPlace | undefined {
  const id = text(x.id, 80);
  return id ? { id, label: text(x.label) } : undefined;
}

function cukContext(v: unknown): CukContext {
  const x = v as Record<string, unknown>;
  const sessions = rows(x.sessions, MAX_SESSIONS, sessionRow);
  const board = rows(x.board, MAX_BOARD, boardRow);
  const workspace = text(x.workspace);
  const project = text(x.project);
  return {
    view: text(x.view, 80),
    ...(workspace ? { workspace } : {}),
    ...(project ? { project } : {}),
    workspaces: rows(x.workspaces, MAX_WORKSPACES, workspaceRow).rows,
    projects: rows(x.projects, MAX_PROJECTS, projectRow).rows,
    sessions: sessions.rows,
    sessionsOmitted: count(x.sessionsOmitted) + sessions.cut,
    board: board.rows,
    boardOmitted: count(x.boardOmitted) + board.cut,
    places: rows(x.places, MAX_PLACES, placeRow).rows,
    // Absent means «no workspace selected», which the prompt says in words; an empty list
    // is a selected workspace with an empty notepad.
    ...(Array.isArray(x.notes) ? { notes: todoRows(x.notes) } : {}),
  };
}

@Controller("cuk")
export class CukController {
  constructor(private chat: CukChatService) {}

  @Post("chat")
  async ask(@Body() b: CukChatAsk, @Req() req: { user: { id: string } }): Promise<CukChatReply> {
    const text = typeof b?.text === "string" ? b.text.trim() : "";
    // Images only: ЦУК has no file tools, so a document could not be read (decision 11).
    // The size and count caps are the Менеджмент chat's, checked on the whole list first.
    const attachments = attachmentRows(b?.attachments).filter((a) => a.mimeType.startsWith("image/"));
    // A blank turn would still spawn a child and still cost a provider call.
    if (!text && attachments.length === 0) throw badRequest("message_empty", "повідомлення порожнє");
    if (!b?.context || typeof b.context !== "object") throw badRequest("section_context_missing", "не передано контекст розділу");
    const context = cukContext(b.context);
    try {
      return await this.chat.ask(
        { text, context, attachments, ...(b.locale === "uk" || b.locale === "en" ? { locale: b.locale } : {}) },
        req.user.id,
      );
    } catch (err) {
      relay(err);
    }
  }

  @Post("chat/reset")
  async reset(@Req() req: { user: { id: string } }): Promise<{ ok: true }> {
    try {
      return await this.chat.reset(req.user.id);
    } catch (err) {
      relay(err);
    }
  }
}
