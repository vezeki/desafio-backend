import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";
import { configureApp } from "./app.setup.ts";
import { loadConfig } from "./config.ts";
import { PinoNestLogger } from "./shared/infrastructure/logging/logger.ts";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.useLogger(new PinoNestLogger());
  configureApp(app);
  await app.listen(config.PORT);
}

await bootstrap();
