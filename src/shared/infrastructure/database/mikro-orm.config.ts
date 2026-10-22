import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { loadConfig } from "../../../config.ts";

export function createMikroOrmConfig(config = loadConfig()) {
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { max: config.DATABASE_POOL_MAX },
    extensions: [Migrator],
    migrations: {
      path: "./migrations",
      tableName: "schema_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });
}

export default createMikroOrmConfig();
