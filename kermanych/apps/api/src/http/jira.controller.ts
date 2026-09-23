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
import { JiraService, type JiraIssueDraft, type JiraWorklogDraft } from "../jira/jira.service";
import { JiraHttpError, type JiraWorklogAdjust } from "../jira/jira-client";
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

  // Every board this workspace has connected. The UI reads the mirror rows straight from
  // Supabase; this endpoint exists so a caller can enumerate boards without a JWT read.
  @Get("integrations/:workspaceId")
  async integrations(@Param("workspaceId") workspaceId: string) {
    try {
      return await this.jira.listIntegrations(workspaceId);
    } catch (err) {
      rethrow(err);
    }
  }

  // Connect (or re-connect) one board. A workspace may hold up to ten; the db refuses the
  // eleventh, and re-connecting a board already present updates it in place.
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

  // Disconnect ONE board by its integration id — the workspace's other boards stay.
  @Delete("integrations/:integrationId")
  async disconnect(@Param("integrationId") integrationId: string) {
    try {
      await this.jira.disconnect(integrationId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  // ── sync tick ────────────────────────────────────────────────────────────────

  @Post("sync/:integrationId")
  async sync(@Param("integrationId") integrationId: string, @Body() b: { full?: boolean }, @Req() req: Authed) {
    try {
      return await this.jira.sync(integrationId, req.user.id, b?.full === true);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── issue actions ────────────────────────────────────────────────────────────

  @Get("issues/:integrationId/:key/transitions")
  async transitions(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.jira.listTransitions(integrationId, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:integrationId/:key/transition")
  async transition(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: { transitionId: string },
    @Req() req: Authed,
  ) {
    if (!b?.transitionId) throw new BadRequestException("transitionId is required");
    try {
      return await this.jira.transition(integrationId, key, b.transitionId, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:integrationId/:key/comments")
  async comment(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: { body: string },
    @Req() req: Authed,
  ) {
    if (!b?.body?.trim()) throw new BadRequestException("comment body is required");
    try {
      return await this.jira.addComment(integrationId, key, b.body.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // «Log work». The acting user is the guard's, never the body's — a worklog carries a
  // name in Jira, and that name is whoever's token signs the call.
  @Post("issues/:integrationId/:key/worklogs")
  async logWork(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: JiraWorklogDraft,
    @Req() req: Authed,
  ) {
    if (!b?.timeSpent?.trim()) throw new BadRequestException("timeSpent is required");
    try {
      return await this.jira.logWork(integrationId, key, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // Editing and removing an entry. Whether this member MAY is Jira's call, made under
  // their own token — the dialog only offers the controls GET /jira/editor-options said
  // Jira would honour, and a refusal that still arrives is Jira's own sentence.
  @Put("issues/:integrationId/:key/worklogs/:worklogId")
  async editWorklog(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Param("worklogId") worklogId: string,
    @Body() b: JiraWorklogDraft,
    @Req() req: Authed,
  ) {
    if (!b?.timeSpent?.trim()) throw new BadRequestException("timeSpent is required");
    if (!b?.started) throw new BadRequestException("started is required");
    try {
      return await this.jira.editWorklog(integrationId, key, worklogId, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // The estimate adjustment travels as query parameters, not a body: a DELETE with a
  // payload is the kind of thing proxies drop, and this is the shape the token routes
  // already use for a delete that needs an argument.
  @Delete("issues/:integrationId/:key/worklogs/:worklogId")
  async removeWorklog(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Param("worklogId") worklogId: string,
    @Query("adjust") adjust: string | undefined,
    @Query("value") value: string | undefined,
    @Req() req: Authed,
  ) {
    try {
      return await this.jira.deleteWorklog(
        integrationId,
        key,
        worklogId,
        adjust ? ({ mode: adjust, value: value ?? "" } as JiraWorklogAdjust) : undefined,
        req.user.id,
      );
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:integrationId/:key/refresh")
  async refresh(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.jira.refreshIssue(integrationId, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  @Post("issues/:integrationId")
  async create(@Param("integrationId") integrationId: string, @Body() b: JiraIssueDraft, @Req() req: Authed) {
    try {
      return await this.jira.createIssue(integrationId, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Put("issues/:integrationId/:key")
  async edit(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: JiraIssueDraft,
    @Req() req: Authed,
  ) {
    try {
      return await this.jira.editIssue(integrationId, key, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("issues/:integrationId/:key")
  async remove(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      await this.jira.deleteIssue(integrationId, key, req.user.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("editor-options/:integrationId")
  async editorOptions(@Param("integrationId") integrationId: string, @Req() req: Authed) {
    try {
      return await this.jira.editorOptions(integrationId, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("assignable/:integrationId")
  async assignable(
    @Param("integrationId") integrationId: string,
    @Query("q") q: string | undefined,
    @Req() req: Authed,
  ) {
    try {
      return await this.jira.assignableUsers(integrationId, q ?? "", req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── attachments ──────────────────────────────────────────────────────────────

  // JSON body with base64 data — the ImageInput convention the session endpoints already
  // use, so the api needs no multipart middleware.
  @Post("issues/:integrationId/:key/attachments")
  async upload(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: { filename: string; data: string; mimeType?: string },
    @Req() req: Authed,
  ) {
    if (!b?.filename?.trim() || !b?.data) throw new BadRequestException("filename and data are required");
    try {
      return await this.jira.uploadAttachment(
        integrationId,
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

  @Get("attachments/:integrationId/:attachmentId")
  async download(
    @Param("integrationId") integrationId: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: Authed,
    @Res() res: StreamResponse,
  ) {
    try {
      const { body, contentType } = await this.jira.downloadAttachment(integrationId, attachmentId, req.user.id);
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

  @Post("issues/:integrationId/:key/launch")
  async launch(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: { projectId: string; transitionId?: string; images?: ImageInput[] },
    @Req() req: Authed,
  ) {
    if (!b?.projectId) throw new BadRequestException("projectId is required");
    try {
      return await this.jira.launch(integrationId, key, b.projectId, req.user.id, b.transitionId, b.images);
    } catch (err) {
      rethrow(err);
    }
  }
}
