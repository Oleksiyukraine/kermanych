import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { RegistryService } from "./registry/registry.service";
import { seedDemo } from "./preview/seed";

// Build + start the Kermanych API. Exported so the Electron main process can host
// it in-process; still self-runs for standalone `node dist/main.js` / `pnpm dev:api`.
export async function bootstrap(opts: { port?: number } = {}): Promise<{ app: INestApplication; url: string }> {
  // Images ride message/create payloads as base64 (omp caps each at 20 MiB),
  // so lift the body limit well past Express's 100 KB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: "64mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "64mb" });
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  app.enableShutdownHooks();
  // Only a preview api sets KERMANYCH_SEED (see preview.service.ts); the real api never
  // does, so its registry is never touched. Idempotent on an already-populated DB.
  if (process.env.KERMANYCH_SEED) seedDemo(app.get(RegistryService));
  const port = opts.port ?? (Number(process.env.PORT) || 4317);
  await app.listen(port, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  console.log(`Kermanych API on ${url}`);
  return { app, url };
}

if (require.main === module) void bootstrap();
