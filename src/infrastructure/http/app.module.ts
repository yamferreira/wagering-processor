import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "../auth/auth.guard";
import type { Container } from "../app/container";
import { TOKENS } from "../app/tokens";
import { HealthController } from "./controllers/health.controller";
import { MetricsController } from "./controllers/metrics.controller";
import { WageringController } from "./controllers/wagering.controller";
import { WalletsController } from "./controllers/wallets.controller";

/** Nest lives only here: controllers are thin adapters over the use cases in the container. */
@Module({})
export class AppModule {
  static register(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: TOKENS.Container, useValue: container },
        { provide: TOKENS.ProviderIdentity, useValue: container.identities },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
