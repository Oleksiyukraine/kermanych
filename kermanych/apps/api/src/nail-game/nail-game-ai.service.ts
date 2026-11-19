// apps/api/src/nail-game/nail-game-ai.service.ts
// «Гвіздки» with AI opponents (docs/specs/2026-11-19-nail-game-ai-opponents.md, decisions 2–5):
// every AI player is a real model on the operator's own omp, one tool-less child per player
// on the shared chat pool. The overlay runs the round and asks each child for its next few
// strikes, one turn at a time; the child keeps the contract and the round's history.
//
// A child lives for one round: `warm` replaces whatever the last round left with a fresh one
// (so the contract is re-sent and the old boards are gone), `release` stops it at the end. The
// pool's idle sweep stops a child whose release never came (a window closed mid-round).
import { homedir } from "node:os";
import { Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import type { NailGameBoard, NailGameMove, ThinkingLevel } from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { MachineResourcesService } from "../machine/machine-resources.service";
import { ModelsService } from "../models/models.service";
import { RpcChatPool, readTurn, type ChatLaunch } from "../assistant/rpc-chat-pool";
import { CodedError } from "../management/coded-error";
import { buildNailGameTurn, parseStrikes } from "./nail-game-prompt";

// A move is one short answer with no tools; measured warm turns take 1–2 s (decision 3). Twenty
// seconds is a wedged child, and the pool drops it so the next move starts a clean one.
const TURN_TIMEOUT_MS = 20_000;

// No thinking: the game is decided by how fast an answer lands as much as by how good it is,
// and every model plays under the same setting so the race is between the models themselves.
const THINKING: ThinkingLevel = "off";

export function nailGameKey(userId: string, model: string): string {
  return `nail-game:${userId}:${model}`;
}

@Injectable()
export class NailGameAiService implements OnModuleDestroy {
  private pool: RpcChatPool;

  constructor(
    registry: RegistryService,
    private models: ModelsService,
    @Optional() resources?: MachineResourcesService,
  ) {
    this.pool = new RpcChatPool({
      label: "nail game",
      turnTimeoutMs: TURN_TIMEOUT_MS,
      registry,
      ...(resources ? { resources } : {}),
    });
  }

  // A fresh child per opponent, started side by side while the countdown runs. A model the
  // machine's omp does not list is refused before anything is spawned.
  async warm(userId: string, models: string[]): Promise<{ ok: true }> {
    this.pool.sweep();
    for (const model of models) {
      if ((await this.models.validModel(model)) === undefined)
        throw new CodedError("nail_game_model_unknown", `модель ${model} недоступна на цьому компʼютері`, { model });
    }
    await Promise.all(
      models.map(async (model) => {
        const key = nailGameKey(userId, model);
        await this.pool.reset(key);
        await this.pool.child(key, () => this.launch(model));
      }),
    );
    return { ok: true };
  }

  async move(userId: string, model: string, board: NailGameBoard): Promise<NailGameMove> {
    const startedAt = Date.now();
    const key = nailGameKey(userId, model);
    return this.pool.enqueue(key, async () => {
      const live = await this.pool.child(key, () => this.launch(model));
      const message = buildNailGameTurn({ first: !live.greeted, board });
      const { events, notices } = await this.pool.drive(key, live, message, []);
      const { raw, usage } = readTurn(events, notices, startedAt);
      return { strikes: parseStrikes(raw, board), ms: Date.now() - startedAt, ...(usage ? { usage } : {}) };
    });
  }

  async release(userId: string, models: string[]): Promise<{ ok: true }> {
    await Promise.all(models.map((model) => this.pool.reset(nailGameKey(userId, model))));
    return { ok: true };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.dropAll();
  }

  // The home directory and no tools, like ЦУК: nothing to read, one provider call per move.
  private launch(model: string): ChatLaunch<never> {
    return { opts: { cwd: homedir(), noTools: true, model, thinking: THINKING } };
  }
}
