import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { PROVIDER_IDENTITY, type ProviderIdentity, type ProviderIdentityPort } from "../../application/provider-identity.ts";

export type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

function isOpen(path: string): boolean {
  return path === "/metrics" || path.startsWith("/health");
}

/**
 * Resolves the caller and attaches it to the request. It does not reject a missing token:
 * the installed port decides that. Health and metrics stay open either way.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (isOpen(request.path)) return true;
    request.providerIdentity = this.identity.authenticate(request.header("authorization"));
    return true;
  }
}
