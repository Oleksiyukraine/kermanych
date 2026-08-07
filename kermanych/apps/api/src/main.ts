import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: "*" });
  app.setGlobalPrefix("api", { exclude: [] });
  await app.listen(4317);
  console.log("Kermanych API on http://localhost:4317");
}
bootstrap();
