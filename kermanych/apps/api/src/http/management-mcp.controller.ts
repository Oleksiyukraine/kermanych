// apps/api/src/http/management-mcp.controller.ts
// POST /api/management/mcp — the Менеджмент assistant's Jira tools as an MCP endpoint
// (management-mcp.service.ts). @Public because the caller is the chat's agent child, which
// holds no Supabase session; the per-child bearer secret checked here is its whole
// credential. The api listens on 127.0.0.1 only (main.ts), so nothing off the machine
// reaches this route at all.
import { Body, Controller, Delete, Get, Headers, HttpException, Post, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { ManagementMcpService } from "../management/management-mcp.service";

// Structural, not `express` — the jira controller's reason: @types/express is not a dependency.
type StatusResponse = { status(code: number): unknown };

@Controller("management/mcp")
export class ManagementMcpController {
  constructor(private mcp: ManagementMcpService) {}

  @Public()
  @Post()
  async post(
    @Headers("authorization") auth: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    const scope = this.mcp.scopeFor(token);
    if (!scope) throw new HttpException("unknown or revoked assistant token", 401);
    const out = await this.mcp.handle(scope, body);
    res.status(out === undefined ? 202 : 200);
    return out;
  }

  // No server-initiated stream and no server-held session: the spec's answer to both is 405,
  // which MCP clients read as «this server does not offer that».
  @Public()
  @Get()
  stream(): never {
    throw new HttpException("no server-sent stream", 405);
  }

  @Public()
  @Delete()
  end(): never {
    throw new HttpException("no session to end", 405);
  }
}
