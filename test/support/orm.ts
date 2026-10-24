import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import { SystemClock } from "../../src/shared/application/clock.ts";
import { UuidV7Generator } from "../../src/shared/application/id-generator.ts";
import { createMikroOrmConfig } from "../../src/shared/infrastructure/database/mikro-orm.config.ts";
import { MikroOrmUnitOfWork, type UnitOfWorkOptions } from "../../src/shared/infrastructure/database/mikro-orm-unit-of-work.ts";
import { prepareTestDatabase } from "./database.ts";

export interface TestPersistence {
  orm: MikroORM;
  unitOfWork: MikroOrmUnitOfWork;
  /** Raw connection for assertions, bypassing the ORM and its identity map. */
  sql: SQL;
  ids: UuidV7Generator;
  clock: SystemClock;
  close(): Promise<void>;
}

export async function createTestPersistence(options: Partial<UnitOfWorkOptions> = {}): Promise<TestPersistence> {
  const url = await prepareTestDatabase();
  const orm = await MikroORM.init(createMikroOrmConfig({ databaseUrl: url, poolMax: 20 }));
  const sql = new SQL(url);
  return {
    orm,
    unitOfWork: new MikroOrmUnitOfWork(orm.em, options),
    sql,
    ids: new UuidV7Generator(),
    clock: new SystemClock(),
    async close() {
      await sql.close();
      await orm.close();
    },
  };
}
