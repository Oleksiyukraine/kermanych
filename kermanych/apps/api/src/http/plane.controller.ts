// apps/api/src/http/plane.controller.ts
// The UI's whole Plane surface. Auto-guarded by the global SupabaseAuthGuard, and the
// acting user always comes from the guard (`req.user.id`), never the body — the same rule
// the Jira controller states: a board client cannot act on somebody else's behalf, and
// here it additionally decides WHOSE Plane key signs the call.
//
// PlaneHttpError keeps its status where it matters: an auth refusal (Plane's 401, or the
// 403 its key check answers — the client normalises both to 401) surfaces as 403 so the UI
// can drop that user to read-only; everything else, a 429 included, is a BadRequest
// carrying Plane's own flattened refusal text for the toast. Never 401: from the local api
// that status means «your Kermanych session is gone» (see jira.controller.ts).
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
  ForbiddenException,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import type { ImageInput } from "@kermanych/core";
import { PlaneService, type PlaneIssueDraft, type PlaneWorklogDraft } from "../plane/plane.service";
import { PlaneHttpError } from "../plane/plane-client";
// Structural, not `express`: @types/express is not a dependency here, and these three
// members are the whole contract the streamed download uses.
type StreamResponse = {
  setHeader(name: string, value: string): void;
  write(chunk: Uint8Array): void;
  end(): void;
};

type Authed = { user: { id: string } };

function rethrow(err: unknown): never {
  if (err instanceof PlaneHttpError && err.status === 401) throw new ForbiddenException("plane token invalid");
  throw new BadRequestException((err as Error).message);
}

// The token routes address a key by (site, Plane workspace) — keys may be workspace-scoped.
function requireAddress(site: string | undefined, workspace: string | undefined): void {
  if (!site?.trim() || !workspace?.trim()) throw new BadRequestException("site and workspace are required");
}

@Controller("plane")
export class PlaneController {
  constructor(private plane: PlaneService) {}

  // ── token (this machine, this user) ──────────────────────────────────────────

  @Get("token")
  tokenStatus(@Query("site") site: string, @Query("workspace") workspace: string, @Req() req: Authed) {
    requireAddress(site, workspace);
    return this.plane.tokenStatus(site, workspace, req.user.id);
  }

  @Put("token")
  async setToken(@Body() b: { siteUrl: string; workspaceSlug: string; token: string }, @Req() req: Authed) {
    if (!b?.siteUrl?.trim() || !b?.workspaceSlug?.trim() || !b?.token?.trim())
      throw new BadRequestException("siteUrl, workspaceSlug and token are required");
    try {
      return await this.plane.setToken(b.siteUrl, b.workspaceSlug, b.token.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("token")
  deleteToken(@Query("site") site: string, @Query("workspace") workspace: string, @Req() req: Authed) {
    requireAddress(site, workspace);
    this.plane.deleteToken(site, workspace, req.user.id);
    return { ok: true };
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  @Get("projects")
  async projects(@Query("site") site: string, @Query("workspace") workspace: string, @Req() req: Authed) {
    requireAddress(site, workspace);
    try {
      return await this.plane.listProjects(site, workspace, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // Every project this workspace has connected. The UI reads the mirror rows straight from
  // Supabase; this endpoint exists so a caller can enumerate them without a JWT read.
  @Get("integrations/:workspaceId")
  async integrations(@Param("workspaceId") workspaceId: string) {
    try {
      return await this.plane.listIntegrations(workspaceId);
    } catch (err) {
      rethrow(err);
    }
  }

  // Connect (or re-connect) one project. A workspace may hold up to ten; the db refuses the
  // eleventh, and re-connecting a project already present updates it in place.
  @Post("integrations")
  async connect(
    @Body() b: { workspaceId: string; siteUrl: string; workspaceSlug: string; projectId: string },
    @Req() req: Authed,
  ) {
    if (!b?.workspaceId || !b?.siteUrl?.trim() || !b?.workspaceSlug?.trim() || !b?.projectId?.trim())
      throw new BadRequestException("workspaceId, siteUrl, workspaceSlug and projectId are required");
    try {
      return await this.plane.connect(b.workspaceId, b.siteUrl, b.workspaceSlug, b.projectId.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // Disconnect ONE project by its integration id — the workspace's others stay.
  @Delete("integrations/:integrationId")
  async disconnect(@Param("integrationId") integrationId: string) {
    try {
      await this.plane.disconnect(integrationId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  // ── sync tick ────────────────────────────────────────────────────────────────

  // `{synced: false, rateLimited: true}` when Plane's per-key budget ran out mid-tick: a
  // quiet answer, not an error — the next tick resumes.
  @Post("sync/:integrationId")
  async sync(@Param("integrationId") integrationId: string, @Body() b: { full?: boolean }, @Req() req: Authed) {
    try {
      return await this.plane.sync(integrationId, req.user.id, b?.full === true);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── issue actions ────────────────────────────────────────────────────────────

  @Get("issues/:integrationId/:key/transitions")
  async transitions(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.plane.listTransitions(integrationId, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // `transitionId` is the target state's id (Plane has no workflow transitions).
  @Post("issues/:integrationId/:key/transition")
  async transition(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: { transitionId: string },
    @Req() req: Authed,
  ) {
    if (!b?.transitionId) throw new BadRequestException("transitionId is required");
    try {
      return await this.plane.transition(integrationId, key, b.transitionId, req.user.id);
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
      return await this.plane.addComment(integrationId, key, b.body.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // «Log work». The acting user is the guard's, never the body's — a worklog carries a
  // name in Plane, and that name is whoever's key signs the call.
  @Post("issues/:integrationId/:key/worklogs")
  async logWork(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: PlaneWorklogDraft,
    @Req() req: Authed,
  ) {
    if (!b?.timeSpent?.trim()) throw new BadRequestException("timeSpent is required");
    try {
      return await this.plane.logWork(integrationId, key, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // Editing and removing an entry. Whether this member MAY is Plane's call, made under
  // their own key — the dialog only offers the controls GET /plane/editor-options allowed,
  // and a refusal that still arrives is Plane's own sentence.
  @Put("issues/:integrationId/:key/worklogs/:worklogId")
  async editWorklog(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Param("worklogId") worklogId: string,
    @Body() b: PlaneWorklogDraft,
    @Req() req: Authed,
  ) {
    if (!b?.timeSpent?.trim()) throw new BadRequestException("timeSpent is required");
    try {
      return await this.plane.editWorklog(integrationId, key, worklogId, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("issues/:integrationId/:key/worklogs/:worklogId")
  async removeWorklog(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Param("worklogId") worklogId: string,
    @Req() req: Authed,
  ) {
    try {
      return await this.plane.deleteWorklog(integrationId, key, worklogId, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:integrationId/:key/refresh")
  async refresh(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.plane.refreshIssue(integrationId, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  @Post("issues/:integrationId")
  async create(@Param("integrationId") integrationId: string, @Body() b: PlaneIssueDraft, @Req() req: Authed) {
    try {
      return await this.plane.createIssue(integrationId, b ?? {}, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Put("issues/:integrationId/:key")
  async edit(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Body() b: PlaneIssueDraft,
    @Req() req: Authed,
  ) {
    try {
      return await this.plane.editIssue(integrationId, key, b ?? {}, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // The editor's starting description, as markdown from the item's own HTML.
  @Get("issues/:integrationId/:key/description")
  async description(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.plane.issueDescription(integrationId, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("issues/:integrationId/:key")
  async remove(@Param("integrationId") integrationId: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      await this.plane.deleteIssue(integrationId, key, req.user.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("editor-options/:integrationId")
  async editorOptions(@Param("integrationId") integrationId: string, @Req() req: Authed) {
    try {
      return await this.plane.editorOptions(integrationId, req.user.id);
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
      return await this.plane.assignableUsers(integrationId, q ?? "", req.user.id);
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
      return await this.plane.uploadAttachment(
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

  // The item's key is in the path because Plane addresses an attachment under its work
  // item, unlike Jira's site-wide attachment ids.
  @Get("attachments/:integrationId/:key/:attachmentId")
  async download(
    @Param("integrationId") integrationId: string,
    @Param("key") key: string,
    @Param("attachmentId") attachmentId: string,
    @Req() req: Authed,
    @Res() res: StreamResponse,
  ) {
    try {
      const { body, contentType } = await this.plane.downloadAttachment(integrationId, key, attachmentId, req.user.id);
      res.setHeader("content-type", contentType);
      // Web stream → Node response without buffering, with a reader loop rather than
      // `for await` — the jira.controller.ts reasoning (DOM-lib ReadableStream typing).
      const reader = body.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) res.write(r.value);
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
      return await this.plane.launch(integrationId, key, b.projectId, req.user.id, b.transitionId, b.images);
    } catch (err) {
      rethrow(err);
    }
  }
}
