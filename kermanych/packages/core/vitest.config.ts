import { defineConfig } from "vitest/config";
// vitest 2 defaults minWorkers to (CPUs - 1) in `run`; without minWorkers: 1 a bare
// `--maxWorkers=4` makes tinypool throw "minThreads and maxThreads must not conflict" and run no tests.
export default defineConfig({ test: { include: ["test/**/*.spec.ts"], minWorkers: 1 } });
