import { Injectable } from "@nestjs/common";
import type { ProviderIdentity, ProviderIdentityPort } from "../../application/provider-identity.ts";

/** Accepts every caller. Replaced by an OIDC client-credentials check when authentication is turned on. */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  authenticate(_authorization: string | undefined): ProviderIdentity | undefined {
    return undefined;
  }
}
