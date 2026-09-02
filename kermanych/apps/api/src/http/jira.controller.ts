// apps/api/src/http/jira.controller.ts
// The UI's whole Jira surface. Auto-guarded by the global SupabaseAuthGuard, and the
// acting user always comes from the guard (`req.user.id`), never the body — the same
// rule POST /sessions/from-task states: a board client cannot act on somebody else's
// behalf, and here it additionally decides WHOSE Jira token signs the call.
//
// JiraHttpError keeps its Jira status where it matters: a 401 surfaces as 401 so the UI
// can drop that user to read-only, everything else is a BadRequest carrying Jira's own
// flattened refusal text for the toast.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import type { ImageInput } from "@kermanych/core";
import { JiraService, type JiraIssueDraft } from "../jira/jira.service";
import { JiraHttpError } from "../jira/jira-client";
// Structural, not `express`: @types/express is not a dependency here, and these three
// members are the whole contract the streamed download uses.
type StreamResponse = {
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): void;
  end(): void;
};

type Authed = { user: { id: string } };

function rethrow(err: unknown): never {
  if (err instanceof JiraHttpError && err.status === 401)
    throw new UnauthorizedException("jira token invalid");
  throw new BadRequestException((err as Error).message);
}

@Controller("jira")
export class JiraController {
  constructor(private jira: JiraService) {}

  // ── token (this machine, this user) ──────────────────────────────────────────

  @Get("token")
  tokenStatus(@Query("site") site: string, @Req() req: Authed) {
    if (!site?.trim()) throw new BadRequestException("site is required");
    return this.jira.tokenStatus(site, req.user.id);
  }

  @Put("token")
  async setToken(@Body() b: { siteUrl: string; email: string; token: string }, @Req() req: Authed) {
    if (!b?.siteUrl?.trim() || !b?.email?.trim() || !b?.token?.trim())
      throw new BadRequestException("siteUrl, email and token are required");
    try {
      return await this.jira.setToken(b.siteUrl, b.email.trim(), b.token.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("token")
  deleteToken(@Query("site") site: string, @Req() req: Authed) {
    if (!site?.trim()) throw new BadRequestException("site is required");
    this.jira.deleteToken(site, req.user.id);
    return { ok: true };
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  @Get("boards")
  async boards(@Query("site") site: string, @Req() req: Authed) {
    if (!site?.trim()) throw new BadRequestException("site is required");
    try {
      return await this.jira.listBoards(site, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("integrations")
  async connect(@Body() b: { workspaceId: string; siteUrl: string; boardId: number }, @Req() req: Authed) {
    if (!b?.workspaceId || !b?.siteUrl?.trim() || typeof b?.boardId !== "number")
      throw new BadRequestException("workspaceId, siteUrl and boardId are required");
    try {
      return await this.jira.connect(b.workspaceId, b.siteUrl, b.boardId, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("integrations/:workspaceId")
  async disconnect(@Param("workspaceId") workspaceId: string) {
    try {
      await this.jira.disconnect(workspaceId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  // ── sync tick ────────────────────────────────────────────────────────────────

  @Post("sync/:workspaceId")
  async sync(@Param("workspaceId") workspaceId: string, @Body() b: { full?: boolean }, @Req() req: Authed) {
    try {
      return await this.jira.sync(workspaceId, req.user.id, b?.full === true);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── issue actions ────────────────────────────────────────────────────────────

  @Get("issues/:workspaceId/:key/transitions")
  async transitions(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.jira.listTransitions(ws, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:workspaceId/:key/transition")
  async transition(
    @Param("workspaceId") ws: string,
    @Param("key") key: string,
    @Body() b: { transitionId: string },
    @Req() req: Authed,
  ) {
    if (!b?.transitionId) throw new BadRequestException("transitionId is required");
    try {
      return await this.jira.transition(ws, key, b.transitionId, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:workspaceId/:key/comments")
  async comment(
    @Param("workspaceId") ws: string,
    @Param("key") key: string,
    @Body() b: { body: string },
    @Req() req: Authed,
  ) {
    if (!b?.body?.trim()) throw new BadRequestException("comment body is required");
    try {
      return await this.jira.addComment(ws, key, b.body.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:workspaceId/:key/refresh")
  async refresh(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.jira.refreshIssue(ws, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  @Post("issues/:workspaceId")
  async create(@Param("workspaceId") ws: string, @Body() b: JiraIssueDraft, @Req() req: Authed) {
    try {
      return await this.jira.createIssue(ws, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Put("issues/:workspaceId/:key")
  async edit(@Param("workspaceId") ws: string, @Param("key") key: string, @Body() b: JiraIssueDraft, @Req() req: Authed) {
    try {
      return await this.jira.editIssue(ws, key, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("issues/:workspaceId/:key")
  async remove(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      await this.jira.deleteIssue(ws, key, req.user.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("editor-options/:workspaceId")
  async editorOptions(@Param("workspaceId") ws: string, @Req() req: Authed) {
    try {
      return await this.jira.editorOptions(ws, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("assignable/:workspaceId")
  async assignable(@Param("workspaceId") ws: string, @Query("q") q: string | undefined, @Req() req: Authed) {
    try {
      return await this.jira.assignableUsers(ws, q ?? "", req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  // JSON body with base64 data — the ImageInput convention the session endpoints already
  // use, so the api needs no multipart middleware.
  @Post("issues/:workspaceId/:key/attachments")
  async upload(
    @Param("workspaceId") ws: string,
    @Param("key") key: string,
    @Body() b: { filename: string; data: string; mimeType?: string },
    @Req() req: Authed,
  ) {
    if (!b?.filename?.trim() || !b?.data) throw new BadRequestException("filename and data are required");
    try {
      return await this.jira.uploadAttachment(
        ws,
        key,
        b.filename.trim(),
        Buffer.from(b.data, "base64"),
        b.mimeType ?? "",
        req.user.id,
      );
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("attachments/:workspaceId/:attachmentId")
  async download(
    @Param("workspaceId") ws: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: Authed,
    @Res() res: StreamResponse,
  ) {
    try {
      const { body, contentType } = await this.jira.downloadAttachment(ws, attachmentId, req.user.id);
      res.setHeader("content-type", contentType);
      // Web stream → Node response without buffering: the file passes through, never
      // touching disk or memory whole.
      for await (const chunk of body) res.write(chunk);
      res.end();
    } catch (err) {
      rethrow(err);
    }
  }

  // ── launch ───────────────────────────────────────────────────────────────────

  @Post("issues/:workspaceId/:key/launch")
  async launch(
    @Param("workspaceId") ws: string,
    @Param("key") key: string,
    @Body() b: { projectId: string; transitionId?: string; images?: ImageInput[] },
    @Req() req: Authed,
  ) {
    if (!b?.projectId) throw new BadRequestException("projectId is required");
    try {
      return await this.jira.launch(ws, key, b.projectId, req.user.id, b.transitionId, b.images);
    } catch (err) {
      rethrow(err);
    }
  }
}
