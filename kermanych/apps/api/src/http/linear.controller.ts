// apps/api/src/http/linear.controller.ts
// The UI's whole Linear surface. Auto-guarded by the global SupabaseAuthGuard, and the
// acting user always comes from the guard (`req.user.id`), never the body — the same rule
// the Jira controller states: a board client cannot act on somebody else's behalf, and here
// it additionally decides WHOSE Linear key signs the call.
//
// LinearHttpError keeps its status where it matters: a 401 (Linear's authentication error)
// surfaces as 401 so the UI can drop that user to read-only, everything else is a
// BadRequest carrying Linear's own userPresentableMessage for the toast.
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
  UnauthorizedException,
} from "@nestjs/common";
import type { ImageInput } from "@kermanych/core";
import { LinearService, type LinearIssueDraft } from "../linear/linear.service";
import { LinearHttpError } from "../linear/linear-client";

type Authed = { user: { id: string } };

function rethrow(err: unknown): never {
  if (err instanceof LinearHttpError && err.status === 401)
    throw new UnauthorizedException("linear token invalid");
  throw new BadRequestException((err as Error).message);
}

@Controller("linear")
export class LinearController {
  constructor(private linear: LinearService) {}

  // ── token (this machine, this user) ──────────────────────────────────────────

  @Get("token")
  tokenStatus(@Query("org") org: string, @Req() req: Authed) {
    if (!org?.trim()) throw new BadRequestException("org is required");
    return this.linear.tokenStatus(org.trim(), req.user.id);
  }

  @Put("token")
  async setToken(@Body() b: { apiKey: string }, @Req() req: Authed) {
    if (!b?.apiKey?.trim()) throw new BadRequestException("apiKey is required");
    try {
      return await this.linear.setToken(b.apiKey.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("token")
  deleteToken(@Query("org") org: string, @Req() req: Authed) {
    if (!org?.trim()) throw new BadRequestException("org is required");
    this.linear.deleteToken(org.trim(), req.user.id);
    return { ok: true };
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  @Get("teams")
  async teams(@Query("org") org: string, @Req() req: Authed) {
    if (!org?.trim()) throw new BadRequestException("org is required");
    try {
      return await this.linear.listTeams(org.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("integrations")
  async connect(@Body() b: { workspaceId: string; orgUrlKey: string; teamId: string }, @Req() req: Authed) {
    if (!b?.workspaceId || !b?.orgUrlKey?.trim() || !b?.teamId?.trim())
      throw new BadRequestException("workspaceId, orgUrlKey and teamId are required");
    try {
      return await this.linear.connect(b.workspaceId, b.orgUrlKey.trim(), b.teamId.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("integrations/:workspaceId")
  async disconnect(@Param("workspaceId") workspaceId: string) {
    try {
      await this.linear.disconnect(workspaceId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  // ── sync tick ────────────────────────────────────────────────────────────────

  @Post("sync/:workspaceId")
  async sync(@Param("workspaceId") workspaceId: string, @Body() b: { full?: boolean }, @Req() req: Authed) {
    try {
      return await this.linear.sync(workspaceId, req.user.id, b?.full === true);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── issue actions ────────────────────────────────────────────────────────────

  @Get("issues/:workspaceId/:key/transitions")
  async transitions(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.linear.listTransitions(ws, key, req.user.id);
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
      return await this.linear.transition(ws, key, b.transitionId, req.user.id);
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
      return await this.linear.addComment(ws, key, b.body.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("issues/:workspaceId/:key/refresh")
  async refresh(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      return await this.linear.refreshIssue(ws, key, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  // ── authoring ────────────────────────────────────────────────────────────────

  @Post("issues/:workspaceId")
  async create(@Param("workspaceId") ws: string, @Body() b: LinearIssueDraft, @Req() req: Authed) {
    try {
      return await this.linear.createIssue(ws, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Put("issues/:workspaceId/:key")
  async edit(
    @Param("workspaceId") ws: string,
    @Param("key") key: string,
    @Body() b: LinearIssueDraft,
    @Req() req: Authed,
  ) {
    try {
      return await this.linear.editIssue(ws, key, b, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("issues/:workspaceId/:key")
  async remove(@Param("workspaceId") ws: string, @Param("key") key: string, @Req() req: Authed) {
    try {
      await this.linear.deleteIssue(ws, key, req.user.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("editor-options/:workspaceId")
  async editorOptions(@Param("workspaceId") ws: string, @Req() req: Authed) {
    try {
      return await this.linear.editorOptions(ws, req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Get("assignable/:workspaceId")
  async assignable(@Param("workspaceId") ws: string, @Query("q") q: string | undefined, @Req() req: Authed) {
    try {
      return await this.linear.assignableUsers(ws, q ?? "", req.user.id);
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
      return await this.linear.launch(ws, key, b.projectId, req.user.id, b.transitionId, b.images);
    } catch (err) {
      rethrow(err);
    }
  }
}
