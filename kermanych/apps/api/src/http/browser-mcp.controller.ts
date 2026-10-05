// apps/api/src/http/browser-mcp.controller.ts
// POST /api/browser/mcp — the session browser's tools as an MCP endpoint
// (browser/browser-mcp.service.ts). @Public because the caller is a session's agent, which
// holds no Supabase session; the per-session bearer checked here is its whole credential and
// names the one session whose browser it may drive. The api listens on 127.0.0.1 only.
import { Body, Controller, Delete, Get, Headers, HttpException, Post, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { BrowserMcpService } from "../browser/browser-mcp.service";

// Structural, not `express` — @types/express is not a dependency.
type StatusResponse = { status(code: number): unknown };

@Controller("browser/mcp")
export class BrowserMcpController {
  constructor(private mcp: BrowserMcpService) {}

  @Public()
  @Post()
  async post(
    @Headers("authorization") auth: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<unknown> {
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    const sessionId = this.mcp.sessionFor(token);
    if (!sessionId) throw new HttpException("unknown or revoked session browser token", 401);
    const out = await this.mcp.handle(sessionId, body);
    res.status(out === undefined ? 202 : 200);
    return out;
  }

  // No server-initiated stream and no server-held session (see management-mcp.controller.ts).
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
