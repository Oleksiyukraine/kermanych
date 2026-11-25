import { defineConfig } from "vitest/config";
// Pure helpers only (no DOM): sorting/grouping, device names, base64url, image size math, the
// dictionaries. vitest 2 needs minWorkers: 1 beside a bare --maxWorkers (packages/core/vitest.config.ts).
export default defineConfig({ test: { include: ["test/**/*.spec.ts"], minWorkers: 1 } });
