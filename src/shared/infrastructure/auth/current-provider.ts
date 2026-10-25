import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ProviderIdentity } from "../../application/provider-identity.ts";
import type { AuthenticatedRequest } from "./provider-auth.guard.ts";

/** The provider named by the token, or `undefined` when this deployment is not authenticating. */
export const CurrentProvider = createParamDecorator((_: unknown, context: ExecutionContext): ProviderIdentity | undefined => {
  return context.switchToHttp().getRequest<AuthenticatedRequest>().providerIdentity;
});
