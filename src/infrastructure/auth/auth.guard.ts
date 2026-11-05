import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { ProviderIdentity, ProviderIdentityPort } from "../../application/ports/provider-identity.port";
import { TOKENS } from "../app/tokens";

const PUBLIC_ROUTE = "wagering:public-route";

/** Marks a route as open (health checks, metrics). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export type AuthenticatedRequest = Request & { identity?: ProviderIdentity };

/**
 * Global guard. Resolves the caller through ProviderIdentityPort and attaches it to the request;
 * controllers then check `assertCanActAs(identity, body.providerId)`. With the no-op port every
 * request passes — the extension point is explicit and wired, only the IdP adapter is missing.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKENS.ProviderIdentity) private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.identity = await this.identities.resolve({ authorization: request.headers.authorization });
    return true;
  }
}
