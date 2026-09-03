// apps/api/src/http/models.controller.ts
import { Controller, Get } from "@nestjs/common";
import type { ModelOption } from "@kermanych/core";
import { ModelsService } from "../models/models.service";
import { RegistryService } from "../registry/registry.service";
import { resolveRuntime } from "../runtime/resolve-runtime";

// Which models THIS machine can actually run for the caller's runtime: omp lists only the
// providers it holds credentials for, and claude reports its own SDK catalog — the picker
// asks per session, so the catalog is both machine-local and runtime-specific. Guarded like
// every other route (the global SupabaseAuthGuard); nothing here is needed before sign-in.
@Controller("models")
export class ModelsController {
  constructor(
    private models: ModelsService,
    private registry: RegistryService,
  ) {}

  @Get()
  list(): Promise<ModelOption[]> {
    // Same resolution the supervisor stamps sessions with: env override beats the cached
    // preference beats omp. The picker then lists the models a new session would actually run.
    return this.models.list(resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime));
  }
}
