// apps/api/test/skills-stub.ts
// DI stub for the supervisor specs that do not exercise the skill library, mirroring
// `offline-auth.ts`. Without it those specs construct SupervisorService with three of its
// four dependencies — an arity error `tsc --noEmit` never sees, because apps/api/tsconfig.json
// includes only `src` — so `this.skills` is undefined, every launch throws into `ompSkills`'
// catch and each spec silently exercises ONLY the degraded branch (while printing a warning).
// An empty view is the honest "this project has no library": the launch passes no --config
// and registers no skill badges, which is exactly what these specs assume.
import type { SkillsService } from "../src/skills/skills.service";

export function stubSkills(): SkillsService {
  return {
    materialize: async () => ({ view: [] }),
    // Same stance for assignments: no project has any, so every instruction is rendered
    // exactly as these specs assert it. Without this the four instruction sites would take
    // their catch and print a warning on every launch.
    assignedFor: async () => ({ block: "", view: [], missing: [] }),
  } as unknown as SkillsService;
}
