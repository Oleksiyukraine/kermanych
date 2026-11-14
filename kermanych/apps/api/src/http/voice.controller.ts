// apps/api/src/http/voice.controller.ts
// The voice api surface. The voice conversation (docs/specs/2026-11-02-voice-conversation.md):
// the operator's OpenAI key on this machine and the SDP exchange with GPT-Live. Local dictation
// (docs/specs/2026-11-14-local-voice-dictation.md): the recognition model and one phrase → text.
// Guarded by the global SupabaseAuthGuard; the acting user comes from the guard, never the body.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Post, Put, Req } from "@nestjs/common";
import { CodedError, badRequest } from "../management/coded-error";
import { LocalSttService } from "../voice/local-stt.service";
import { VoiceService, type VoiceSessionRequest } from "../voice/voice.service";

type Authed = { user: { id: string } };

function relay(err: unknown): never {
  if (err instanceof CodedError) throw badRequest(err.code, err.message, err.params);
  throw new BadRequestException((err as Error).message);
}

@Controller("voice")
export class VoiceController {
  constructor(
    private voice: VoiceService,
    private stt: LocalSttService,
  ) {}

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

  // ── local dictation ──
  // The model is this machine's, not the user's: no user id reaches LocalSttService.

  @Get("model")
  model() {
    return this.stt.status();
  }

  // Starts the download or continues it after a break; while one runs, answers its progress.
  @Post("model/download")
  @HttpCode(200)
  download() {
    return this.stt.download();
  }

  // The bytes downloaded so far stay on disk for the next download to continue from.
  @Delete("model/download")
  cancelDownload() {
    return this.stt.cancelDownload();
  }

  @Delete("model")
  removeModel() {
    return this.stt.remove();
  }

  // 🎤 was pressed: the engine starts loading while the first phrase is spoken (decision 9).
  @Post("stt/warm")
  @HttpCode(200)
  warm() {
    try {
      this.stt.warm();
      return { ok: true };
    } catch (err) {
      relay(err);
    }
  }

  // One phrase: a base64 16 kHz mono 16-bit WAV and Whisper's language code.
  @Post("transcribe")
  @HttpCode(200)
  async transcribe(@Body() b: { audio?: unknown; language?: unknown }) {
    try {
      return { text: await this.stt.transcribe(b?.audio, b?.language) };
    } catch (err) {
      relay(err);
    }
  }
}
