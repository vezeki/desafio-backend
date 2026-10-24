import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate, recreateDatabase } from "../../support/database.ts";

const INITIAL = "Migration20261023000000InitialSchema";
const DEFERRABLE_FKS = "Migration20261024000000DeferrableLedgerForeignKeys";
const ALL = [INITIAL, DEFERRABLE_FKS];
const TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];
const DEFERRED_FKS = ["fk_ledger_transaction_wallet", "fk_ledger_wallet_currency", "fk_wtx_reference"];

async function query<T>(url: string, run: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return await run(sql);
  } finally {
    await sql.close();
  }
}

const userTables = (url: string) =>
  query(url, async (sql) => {
    const rows = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'schema_migrations'
      order by table_name`;
    return rows.map((row: { table_name: string }) => row.table_name);
  });

const deferredForeignKeys = (url: string) =>
  query(url, async (sql) => {
    const rows = await sql`
      select conname from pg_constraint
      where contype = 'f' and condeferrable and condeferred
      order by conname`;
    return rows.map((row: { conname: string }) => row.conname);
  });

describe("migrations", () => {
  test("apply, revert one by one and re-apply cleanly", async () => {
    const url = await recreateDatabase("wagering_migrations_test");

    expect(await migrate(url, "up")).toEqual(ALL);
    expect(await userTables(url)).toEqual(TABLES);
    expect(await deferredForeignKeys(url)).toEqual(DEFERRED_FKS);

    expect(await migrate(url, "down")).toEqual([DEFERRABLE_FKS]);
    expect(await deferredForeignKeys(url)).toEqual([]);
    expect(await userTables(url)).toEqual(TABLES);

    expect(await migrate(url, "down")).toEqual([INITIAL]);
    expect(await userTables(url)).toEqual([]);

    expect(await migrate(url, "up")).toEqual(ALL);
    expect(await userTables(url)).toEqual(TABLES);
    expect(await deferredForeignKeys(url)).toEqual(DEFERRED_FKS);

    expect(await migrate(url, "up")).toEqual([]);
  }, 30_000);
});
