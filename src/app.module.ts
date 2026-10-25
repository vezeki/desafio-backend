import { type DynamicModule, Global, Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { APP_CONFIG, type AppConfig } from "./config.ts";
import { HealthController } from "./health/health.controller.ts";
import { createMikroOrmConfig } from "./shared/infrastructure/database/mikro-orm.config.ts";
import { PersistenceModule } from "./shared/infrastructure/database/persistence.module.ts";
import { MetricsModule } from "./shared/infrastructure/metrics/metrics.module.ts";
import { MessagingModule } from "./messaging/messaging.module.ts";
import { AuthModule } from "./shared/infrastructure/auth/auth.module.ts";
import { SqsModule } from "./shared/infrastructure/sqs/sqs.module.ts";
import { WageringModule } from "./wagering/wagering.module.ts";
import { WalletModule } from "./wallet/wallet.module.ts";

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        MikroOrmModule.forRoot({ ...createMikroOrmConfig({}, config), registerRequestContext: true }),
        MetricsModule,
        AuthModule,
        PersistenceModule,
        SqsModule,
        MessagingModule,
        WalletModule,
        WageringModule,
      ],
      controllers: [HealthController],
    };
  }
}
