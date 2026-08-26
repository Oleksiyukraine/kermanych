// apps/api/src/http/usage.controller.ts
import { Controller, Get } from "@nestjs/common";
import type { SubscriptionUsage } from "@kermanych/core";
import { UsageService } from "../usage/usage.service";

// What THIS machine's provider plan has left. Local-only by nature: the account behind the
// agents is the operator's, the figures never touch the cloud mirror, and only this process
// can ask omp for them — hence a REST read rather than anything on the team board.
@Controller("usage")
export class UsageController {
  constructor(private usage: UsageService) {}

  @Get("subscription")
  subscription(): Promise<SubscriptionUsage> {
    return this.usage.subscription();
  }
}
