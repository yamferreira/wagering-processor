import type { ProviderIdentity, ProviderIdentityPort } from "../../application/ports/provider-identity.port";

/**
 * Explicit no-op identity: authentication is out of the evaluated scope (§2 of the challenge).
 * Every caller may act as any provider. Replace with an OIDC adapter (ARCHITECTURE.md §10).
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return { subject: "anonymous", providerIds: "*" };
  }
}
