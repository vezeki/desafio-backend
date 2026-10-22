import { Global, Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { APP_CONFIG, loadConfig, type AppConfig } from "./config.ts";
import { createMikroOrmConfig } from "./shared/infrastructure/database/mikro-orm.config.ts";
import { SqsModule } from "./shared/infrastructure/sqs/sqs.module.ts";
import { HealthController } from "./health/health.controller.ts";

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
class ConfigModule {}

@Module({
  imports: [
    ConfigModule,
    MikroOrmModule.forRoot({ ...createMikroOrmConfig(), registerRequestContext: true }),
    SqsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
