import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PROVIDER_IDENTITY } from "../../application/provider-identity.ts";
import { NoopProviderIdentity } from "./noop-provider-identity.ts";
import { ProviderAuthGuard } from "./provider-auth.guard.ts";

@Global()
@Module({
  providers: [
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
