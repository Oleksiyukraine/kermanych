// apps/api/src/http/slack.controller.ts
// The UI's whole Slack surface. Auto-guarded by the global SupabaseAuthGuard, and the
// acting user always comes from the guard (`req.user.id`), never the body — the Jira/Linear
// rule: it decides WHOSE stored tokens a call reads, and whose machine hosts the bot.
//
// Slack's `invalid_auth`/`not_authed` surface as 401 so the UI can ask for fresh tokens;
// every other failure is a BadRequest carrying the message for the toast.
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
import { SlackService } from "../slack/slack.service";
import { isSlackAuthError } from "../slack/slack-client";

type Authed = { user: { id: string } };

function rethrow(err: unknown): never {
  if (isSlackAuthError(err)) throw new UnauthorizedException("slack token invalid");
  throw new BadRequestException((err as Error).message);
}

@Controller("slack")
export class SlackController {
  constructor(private slack: SlackService) {}

  // ── tokens (this machine, this user, this workspace) ─────────────────────────

  @Get("token")
  tokenStatus(@Query("workspace") workspace: string, @Req() req: Authed) {
    if (!workspace?.trim()) throw new BadRequestException("workspace is required");
    return this.slack.tokenStatus(workspace.trim(), req.user.id);
  }

  // The prefixes are checked here because the two tokens are easy to paste the wrong way
  // round, and Slack's answer to that (`not_allowed_token_type`) explains nothing.
  @Put("token")
  async setToken(@Body() b: { workspaceId: string; botToken: string; appToken: string }, @Req() req: Authed) {
    if (!b?.workspaceId || !b?.botToken?.trim() || !b?.appToken?.trim())
      throw new BadRequestException("workspaceId, botToken and appToken are required");
    if (!b.botToken.trim().startsWith("xoxb-")) throw new BadRequestException("botToken must be a bot token (xoxb-…)");
    if (!b.appToken.trim().startsWith("xapp-"))
      throw new BadRequestException("appToken must be an app-level token (xapp-…)");
    try {
      return await this.slack.setToken(b.workspaceId, b.botToken.trim(), b.appToken.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("token")
  deleteToken(@Query("workspace") workspace: string, @Req() req: Authed) {
    if (!workspace?.trim()) throw new BadRequestException("workspace is required");
    this.slack.deleteToken(workspace.trim(), req.user.id);
    return { ok: true };
  }

  // ── connect flow ─────────────────────────────────────────────────────────────

  @Get("channels")
  async channels(@Query("workspace") workspace: string, @Req() req: Authed) {
    if (!workspace?.trim()) throw new BadRequestException("workspace is required");
    try {
      return await this.slack.channels(workspace.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Post("integrations")
  async connect(@Body() b: { workspaceId: string; channelId: string }, @Req() req: Authed) {
    if (!b?.workspaceId || !b?.channelId?.trim()) throw new BadRequestException("workspaceId and channelId are required");
    try {
      return await this.slack.connect(b.workspaceId, b.channelId.trim(), req.user.id);
    } catch (err) {
      rethrow(err);
    }
  }

  @Delete("integrations/:workspaceId")
  async disconnect(@Param("workspaceId") workspaceId: string, @Req() req: Authed) {
    try {
      await this.slack.disconnect(workspaceId, req.user.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }
}
