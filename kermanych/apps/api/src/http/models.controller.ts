// apps/api/src/http/models.controller.ts
import { Controller, Get } from "@nestjs/common";
import type { ModelOption } from "@kermanych/core";
import { ModelsService } from "../models/models.service";

// Which models THIS machine can actually run: omp lists only the providers it holds
// credentials for, so the catalog is machine-local. Guarded like every other route (the
// global SupabaseAuthGuard); nothing here is needed before sign-in.
@Controller("models")
export class ModelsController {
  constructor(private models: ModelsService) {}

  @Get()
  list(): Promise<ModelOption[]> {
    return this.models.list();
  }
}
