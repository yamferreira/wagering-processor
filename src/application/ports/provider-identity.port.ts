import { ApplicationError } from "../errors";

/** Authenticated caller. With a real IdP this comes from a validated OIDC access token. */
export interface ProviderIdentity {
  subject: string;
  /** Providers this caller may act as; "*" only for the no-op/development identity. */
  providerIds: "*" | readonly string[];
}

export interface TransportCredentials {
  authorization?: string | undefined;
}

/**
 * Extension point for authentication (§2 of the challenge). Not implemented on purpose: see
 * ARCHITECTURE.md §10 for the Keycloak (OIDC client-credentials per provider) design.
 */
export interface ProviderIdentityPort {
  resolve(credentials: TransportCredentials): Promise<ProviderIdentity>;
}

export class UnauthenticatedError extends ApplicationError {
  readonly code = "UNAUTHENTICATED";

  constructor() {
    super("Missing or invalid credentials");
  }
}

export class ProviderForbiddenError extends ApplicationError {
  readonly code = "PROVIDER_FORBIDDEN";

  constructor(readonly providerId: string) {
    super(`Caller is not allowed to act as provider ${providerId}`);
  }
}

/** The body's providerId must be one the caller is allowed to act as. */
export function assertCanActAs(identity: ProviderIdentity, providerId: string): void {
  if (identity.providerIds === "*") return;
  if (!identity.providerIds.includes(providerId)) throw new ProviderForbiddenError(providerId);
}
