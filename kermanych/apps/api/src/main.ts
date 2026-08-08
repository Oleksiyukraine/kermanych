import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
async function bootstrap() {
  // Images ride message/create payloads as base64 (omp caps each at 20 MiB),
  // so lift the body limit well past Express's 100 KB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: "64mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "64mb" });
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  const port = Number(process.env.PORT) || 4317;
  await app.listen(port);
  console.log(`Kermanych API on http://localhost:${port}`);
}
bootstrap();
