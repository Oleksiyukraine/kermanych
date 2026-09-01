// apps/api/src/http/models.controller.ts
import { Controller, Get } from "@nestjs/common";
import type { ModelOption } from "@kermanych/core";
import { ModelsService } from "../models/models.service";

// Which models THIS machine can actually run: omp lists only the providers it holds
// credentials for, so the catalog is machine-local by nature — the same reason the usage
// figures are a REST read rather than anything mirrored to the cloud board. Guarded like
// every other route (the global SupabaseAuthGuard); nothing here is needed before sign-in.
@Controller("models")
export class ModelsController {
  constructor(private models: ModelsService) {}

  @Get()
  list(): Promise<ModelOption[]> {
    return this.models.list();
  }
}
