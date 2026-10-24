import { SQL } from "bun";
import { expect } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "../../src/shared/infrastructure/database/mikro-orm.config.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

export function databaseUrl(name: string, base = TEST_DATABASE_URL): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function recreateDatabase(name: string): Promise<string> {
  const admin = new SQL(databaseUrl("postgres"));
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  return databaseUrl(name);
}

export async function createDatabaseIfMissing(name: string): Promise<string> {
  const admin = new SQL(databaseUrl("postgres"));
  try {
    const [row] = await admin`select 1 as exists from pg_database where datname = ${name}`;
    if (!row) await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  return databaseUrl(name);
}

export async function migrate(url: string, direction: "up" | "down" = "up"): Promise<string[]> {
  const orm = await MikroORM.init(createMikroOrmConfig({ databaseUrl: url, poolMax: 1 }));
  try {
    const result = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
    return result.map((migration) => migration.name);
  } finally {
    await orm.close();
  }
}

let prepared: Promise<string> | undefined;

/** Shared test database with all migrations applied. Tests isolate themselves with fresh ids, never by truncating. */
export function prepareTestDatabase(): Promise<string> {
  prepared ??= (async () => {
    const name = new URL(TEST_DATABASE_URL).pathname.slice(1);
    const url = await createDatabaseIfMissing(name);
    await migrate(url);
    return url;
  })();
  return prepared;
}

export async function expectConstraint(operation: Promise<unknown>, constraint: string): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected violation of ${constraint}`).toBeDefined();
  expect((error as { constraint?: string }).constraint).toBe(constraint);
}
