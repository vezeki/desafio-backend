import { Global, Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { CLOCK, SystemClock } from "../../application/clock.ts";
import { ID_GENERATOR, UuidV7Generator } from "../../application/id-generator.ts";
import { UNIT_OF_WORK } from "../../application/unit-of-work.ts";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work.ts";

@Global()
@Module({
  providers: [
    { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm.em) },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
})
export class PersistenceModule {}
