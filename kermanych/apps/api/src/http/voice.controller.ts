// apps/api/src/http/voice.controller.ts
// The voice conversation's api surface (docs/specs/2026-11-02-voice-conversation.md): the
// operator's OpenAI key on this machine and the SDP exchange with GPT-Live. Guarded by the
// global SupabaseAuthGuard; the acting user comes from the guard, never the body.
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, Req } from "@nestjs/common";
import { CodedError, badRequest } from "../management/coded-error";
import { VoiceService, type VoiceSessionRequest } from "../voice/voice.service";

type Authed = { user: { id: string } };

function relay(err: unknown): never {
  if (err instanceof CodedError) throw badRequest(err.code, err.message, err.params);
  throw new BadRequestException((err as Error).message);
}

@Controller("voice")
export class VoiceController {
  constructor(private voice: VoiceService) {}

  @Get("key")
  key(@Req() req: Authed) {
    return this.voice.keyStatus(req.user.id);
  }

  // An empty key deletes the stored one.
  @Put("key")
  setKey(@Body() b: { key?: unknown }, @Req() req: Authed) {
    if (typeof b?.key !== "string") throw new BadRequestException("key must be a string");
    return this.voice.setKey(req.user.id, b.key);
  }

  @Post("check")
  @HttpCode(200)
  async check(@Req() req: Authed) {
    try {
      await this.voice.check(req.user.id);
      return { ok: true };
    } catch (err) {
      relay(err);
    }
  }

  @Post("session")
  async session(@Body() b: VoiceSessionRequest, @Req() req: Authed) {
    try {
      return await this.voice.createSession(req.user.id, b ?? ({} as VoiceSessionRequest));
    } catch (err) {
      relay(err);
    }
  }
}
