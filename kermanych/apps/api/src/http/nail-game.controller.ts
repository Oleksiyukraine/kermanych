// apps/api/src/http/nail-game.controller.ts
// «Гвіздки» with AI opponents (docs/specs/2026-11-19-nail-game-ai-opponents.md): start the
// opponents' children, ask one for its move, stop them. Guarded by the global
// SupabaseAuthGuard like every chat route, for the same reason: each move spends the
// operator's own provider plan. Children are keyed by the guard's user id and the model.
import { Body, Controller, Post, Req } from "@nestjs/common";
import { NAIL_GAME_MAX_OPPONENTS, type NailGameMove, type NailGameMoveAsk } from "@kermanych/core";
import { NailGameAiService } from "../nail-game/nail-game-ai.service";
import { badRequest, relay } from "../management/coded-error";
import { readNailGameBoard } from "../nail-game/nail-game-prompt";

const MAX_MODEL_ID = 200;

const modelId = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= MAX_MODEL_ID ? v.trim() : null;

// 1…NAIL_GAME_MAX_OPPONENTS distinct model ids, or a 400.
function opponents(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(modelId) : [];
  const ids = list.filter((m): m is string => m !== null);
  if (ids.length === 0 || ids.length !== list.length || ids.length > NAIL_GAME_MAX_OPPONENTS || new Set(ids).size !== ids.length)
    throw badRequest("nail_game_opponents_invalid", `оберіть від 1 до ${NAIL_GAME_MAX_OPPONENTS} різних моделей-суперників`, {
      max: NAIL_GAME_MAX_OPPONENTS,
    });
  return ids;
}

type Req = { user: { id: string } };

@Controller("nail-game")
export class NailGameController {
  constructor(private ai: NailGameAiService) {}

  @Post("ai/warm")
  async warm(@Body() b: { models?: unknown }, @Req() req: Req): Promise<{ ok: true }> {
    const models = opponents(b?.models);
    try {
      return await this.ai.warm(req.user.id, models);
    } catch (err) {
      relay(err);
    }
  }

  @Post("ai/move")
  async move(@Body() b: Partial<NailGameMoveAsk>, @Req() req: Req): Promise<NailGameMove> {
    const [model] = opponents([b?.model]);
    const board = readNailGameBoard(b?.board);
    if (!board) throw badRequest("nail_game_board_invalid", "гра надіслала зіпсований стан дошки");
    try {
      return await this.ai.move(req.user.id, model!, board);
    } catch (err) {
      relay(err);
    }
  }

  @Post("ai/release")
  async release(@Body() b: { models?: unknown }, @Req() req: Req): Promise<{ ok: true }> {
    return this.ai.release(req.user.id, opponents(b?.models));
  }
}
