// apps/api/src/cuk/cuk-chat.service.ts
// ЦУК («Центр управління Керманича»): the console behind the avatar. One agent child per
// user — a single global conversation (spec decision 5) — on the shared chat pool
// (../assistant/rpc-chat-pool.ts), the same mechanics the Менеджмент assistant runs on.
//
// What differs is deliberate (decision 11): the fast model, no tools at all, no MCP. The
// console's turn is «що чекає на мене» or «відкрий налаштування», answered from the digest
// the browser sends; reading files would be the launched agent's job, done slower. The
// actions the model states are validated in core and executed in the BROWSER.
import { homedir } from "node:os";
import { Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import {
  expandHelpers,
  helperNotice,
  parseCukReply,
  type CukChatAsk,
  type CukChatReply,
  type ImageInput,
} from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import { MachineResourcesService } from "../machine/machine-resources.service";
import { FAST_MODEL } from "../assistant/models";
import { RpcChatPool, readTurn } from "../assistant/rpc-chat-pool";
import { todayIso } from "../management/management-prompt";
import { buildCukTurn } from "./cuk-prompt";

// A ЦУК turn has no tools: one provider call and the prose it decodes. Two minutes is far
// beyond that, so hitting it means the child is stuck and it is dropped.
const TURN_TIMEOUT_MS = 120_000;

// The conversation key: one per user, never one per workspace — switching workspace must not
// end the conversation.
export function cukKey(userId: string): string {
  return `cuk:${userId}`;
}

@Injectable()
export class CukChatService implements OnModuleDestroy {
  private pool: RpcChatPool;

  constructor(
    registry: RegistryService,
    // Optional for specs, like the Менеджмент chat's.
    @Optional() resources?: MachineResourcesService,
  ) {
    this.pool = new RpcChatPool({
      label: "cuk chat",
      turnTimeoutMs: TURN_TIMEOUT_MS,
      registry,
      ...(resources ? { resources } : {}),
    });
  }

  async ask(input: CukChatAsk, userId: string): Promise<CukChatReply> {
    const startedAt = Date.now();
    this.pool.sweep();
    const key = cukKey(userId);
    return this.pool.enqueue(key, () => this.turn(key, input, startedAt));
  }

  // «Новий чат»: the child holds the whole conversation, so it goes (RpcChatPool.reset).
  async reset(userId: string): Promise<{ ok: true }> {
    this.pool.sweep();
    await this.pool.reset(cukKey(userId));
    return { ok: true };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.dropAll();
  }

  private async turn(key: string, input: CukChatAsk, startedAt: number): Promise<CukChatReply> {
    // The home directory: no repository this child should be able to wander into — and it
    // has no tool to wander with.
    const live = await this.pool.child(key, () => ({ opts: { cwd: homedir(), noTools: true, model: FAST_MODEL } }));
    // Expanded before buildCukTurn wraps the text, or a leading `/helper` stops being leading.
    const helped = expandHelpers(input.text);
    // Images only, and only through the image slots: there is no file tool to open anything
    // else with (the controller drops non-images before they get here).
    const images: ImageInput[] = (input.attachments ?? [])
      .filter((a) => a.mimeType.startsWith("image/"))
      .map((a) => ({ data: a.data, mimeType: a.mimeType }));
    const message = buildCukTurn({
      first: !live.greeted,
      context: input.context,
      today: todayIso(),
      text: helped.text,
      ...(input.locale ? { locale: input.locale } : {}),
    });
    const { events, notices } = await this.pool.drive(key, live, message, images);
    if (helped.used.length) notices.unshift(helperNotice(helped.used));
    const { raw, usage, model } = readTurn(events, notices, startedAt);
    const parsed = parseCukReply(raw);
    return {
      text: parsed.text,
      actions: parsed.actions,
      rejected: parsed.rejected,
      notices,
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model }),
      ms: Date.now() - startedAt,
    };
  }
}
