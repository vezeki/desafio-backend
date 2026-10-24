import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { loadConfig } from "../../../config.ts";

export interface MikroOrmConfigOverrides {
  databaseUrl?: string;
  poolMax?: number;
}

export function createMikroOrmConfig(overrides: MikroOrmConfigOverrides = {}, config = loadConfig()) {
  return defineConfig({
    clientUrl: overrides.databaseUrl ?? config.DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { max: overrides.poolMax ?? config.DATABASE_POOL_MAX },
    // Bun runs TypeScript natively, so migrations are loaded from the .ts sources.
    preferTs: true,
    extensions: [Migrator],
    migrations: {
      path: "./migrations",
      pathTs: "./migrations",
      tableName: "schema_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    debug: false,
  });
}

export default createMikroOrmConfig();
