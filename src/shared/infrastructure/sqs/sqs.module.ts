import { Global, Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG, type AppConfig } from "../../../config.ts";

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.AWS_REGION,
          endpoint: config.AWS_ENDPOINT_URL,
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          },
        }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule {}
