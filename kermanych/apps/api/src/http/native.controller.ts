// apps/api/src/http/native.controller.ts
// POST /api/native/:id/claude, /omp and /codex — a native session's status hooks
// (docs/specs/2026-10-05-native-sessions.md, docs/specs/2026-10-16-native-codex.md). @Public
// because the caller is the harness's own hook (claude's `curl` line, codex's curl script, the
// omp extension's `fetch`), which holds no Supabase session; the bearer secret minted for that
// session's current launch is its whole credential, as for management-mcp. The api listens on
// 127.0.0.1 only (main.ts).
//
// GET / PUT /api/native/settings — how native TUIs launch on this machine (core NativeSettings),
// read and changed by Налаштування → ШІ-провайдер. Signed-in like any settings route, and applied
// at the next start or resume of a session: a running TUI keeps the screen it was started on.
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpException, Param, Post, Put } from "@nestjs/common";
import type { NativeSettings } from "@kermanych/core";
import { Public } from "../auth/public.decorator";
import { NativeSessionService } from "../native/native-session.service";
import { RegistryService } from "../registry/registry.service";

@Controller("native")
export class NativeController {
  constructor(
    private native: NativeSessionService,
    private registry: RegistryService,
  ) {}

  @Get("settings")
  settings(): NativeSettings {
    return this.registry.getNativeSettings();
  }

  @Put("settings")
  updateSettings(@Body() b: { claudeFullScreen?: unknown }): NativeSettings {
    if (typeof b?.claudeFullScreen !== "boolean") throw new BadRequestException("claudeFullScreen must be a boolean");
    this.registry.setNativeSettings({ claudeFullScreen: b.claudeFullScreen });
    return this.registry.getNativeSettings();
  }

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

  @Public()
  @Post(":id/codex")
  @HttpCode(204)
  codex(@Param("id") id: string, @Headers("authorization") auth: string | undefined, @Body() body: unknown): void {
    this.native.codexHook(id, this.checked(id, auth, body));
  }

  private checked(id: string, auth: string | undefined, body: unknown): Record<string, unknown> {
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    if (!this.native.authorize(id, token)) throw new HttpException("unknown or revoked session token", 401);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }
}
