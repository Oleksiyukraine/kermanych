// apps/api/src/http/native.controller.ts
// POST /api/native/:id/claude and /api/native/:id/omp — a native session's status hooks
// (docs/specs/2026-10-05-native-sessions.md). @Public because the caller is the harness's own
// hook (a `curl` line for claude, the omp extension's `fetch`), which holds no Supabase
// session; the bearer secret minted for that session's current launch is its whole
// credential, as for management-mcp. The api listens on 127.0.0.1 only (main.ts).
import { Body, Controller, Headers, HttpCode, HttpException, Param, Post } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { NativeSessionService } from "../native/native-session.service";

@Controller("native")
export class NativeController {
  constructor(private native: NativeSessionService) {}

  @Public()
  @Post(":id/claude")
  @HttpCode(204)
  claude(@Param("id") id: string, @Headers("authorization") auth: string | undefined, @Body() body: unknown): void {
    this.native.claudeHook(id, this.checked(id, auth, body));
  }

  @Public()
  @Post(":id/omp")
  @HttpCode(204)
  omp(@Param("id") id: string, @Headers("authorization") auth: string | undefined, @Body() body: unknown): void {
    this.native.ompEvent(id, this.checked(id, auth, body));
  }

  private checked(id: string, auth: string | undefined, body: unknown): Record<string, unknown> {
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    if (!this.native.authorize(id, token)) throw new HttpException("unknown or revoked session token", 401);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }
}
