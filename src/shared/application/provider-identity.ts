import { DomainError } from "../domain/domain-error.ts";

/** The caller, once a token has been checked. Absent while authentication is not wired. */
export interface ProviderIdentity {
  providerId: string;
}

/**
 * Turns a bearer token into a provider. The no-op adapter returns `undefined`:
 * this deployment does not require a token. An OIDC adapter would validate the
 * signature and read the `provider_id` claim, or throw when the token is bad.
 */
export interface ProviderIdentityPort {
  authenticate(authorization: string | undefined): ProviderIdentity | undefined;
}

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

export class ProviderMismatchError extends DomainError {
  readonly code = "PROVIDER_MISMATCH";

  constructor() {
    super("authenticated provider is not allowed to act as this provider");
  }
}

/**
 * When nobody is authenticated, the payload's provider is accepted: that is the current deployment.
 * When a token named a provider, it must be the same one the request is acting as.
 */
export function assertProviderScope(identity: ProviderIdentity | undefined, providerId: string): void {
  if (!identity || identity.providerId === providerId) return;
  throw new ProviderMismatchError();
}
