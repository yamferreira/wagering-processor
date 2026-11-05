import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "./mikro-orm.config";
import { ENTITY_SCHEMAS } from "./schemas";

export async function initOrm(clientUrl: string, poolMax = 20): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig({ clientUrl, poolMax, entities: ENTITY_SCHEMAS }));
}
