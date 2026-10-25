import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { assertProviderScope, ProviderMismatchError } from "../../../src/shared/application/provider-identity.ts";
import { ProviderAuthGuard, type AuthenticatedRequest } from "../../../src/shared/infrastructure/auth/provider-auth.guard.ts";
import { NoopProviderIdentity } from "../../../src/shared/infrastructure/auth/noop-provider-identity.ts";
import { ApiExceptionFilter } from "../../../src/shared/infrastructure/http/api-exception.filter.ts";

function contextFor(request: Partial<AuthenticatedRequest> & { path: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe("provider scope", () => {
  test("no identity means the deployment is open, and a matching identity is accepted", () => {
    expect(() => assertProviderScope(undefined, "provider-a")).not.toThrow();
    expect(() => assertProviderScope({ providerId: "provider-a" }, "provider-a")).not.toThrow();
  });

  test("a token for another provider is forbidden and is not a business rejection", () => {
    expect(() => assertProviderScope({ providerId: "provider-a" }, "provider-b")).toThrow(ProviderMismatchError);

    const response = {
      statusCode: 0,
      body: undefined as { code?: string; status?: number } | undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      json(body: { code?: string; status?: number }) {
        this.body = body;
      },
      setHeader() {},
    };
    new ApiExceptionFilter().catch(new ProviderMismatchError(), {
      switchToHttp: () => ({
        getRequest: () => ({ path: "/wagering/transactions" }),
        getResponse: () => response,
      }),
    } as never);

    expect(response.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(response.body).toMatchObject({ code: "PROVIDER_MISMATCH", status: 403 });
  });

  test("the guard leaves health and metrics alone and attaches the resolved caller", () => {
    const guard = new ProviderAuthGuard({
      authenticate: (authorization) => (authorization ? { providerId: "provider-a" } : undefined),
    });
    const wager = { path: "/wagering/transactions", header: () => "Bearer token" } as unknown as AuthenticatedRequest;
    expect(guard.canActivate(contextFor(wager))).toBe(true);
    expect(wager.providerIdentity).toEqual({ providerId: "provider-a" });

    const health = { path: "/health/ready", header: () => undefined } as unknown as AuthenticatedRequest;
    expect(guard.canActivate(contextFor(health))).toBe(true);
    expect(health.providerIdentity).toBeUndefined();

    const metrics = { path: "/metrics", header: () => "Bearer token" } as unknown as AuthenticatedRequest;
    expect(guard.canActivate(contextFor(metrics))).toBe(true);
    expect(metrics.providerIdentity).toBeUndefined();
  });

  test("the installed adapter authenticates nobody", () => {
    expect(new NoopProviderIdentity().authenticate("Bearer anything")).toBeUndefined();
    expect(new NoopProviderIdentity().authenticate(undefined)).toBeUndefined();
  });
});
