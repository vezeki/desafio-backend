import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate, recreateDatabase } from "../../support/database.ts";

const TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];

async function userTables(url: string): Promise<string[]> {
  const sql = new SQL(url);
  try {
    const rows = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'schema_migrations'
      order by table_name`;
    return rows.map((row: { table_name: string }) => row.table_name);
  } finally {
    await sql.close();
  }
}

describe("migrations", () => {
  test("apply, revert and re-apply cleanly", async () => {
    const url = await recreateDatabase("wagering_migrations_test");

    expect(await migrate(url, "up")).toEqual(["Migration20261023000000InitialSchema"]);
    expect(await userTables(url)).toEqual(TABLES);

    expect(await migrate(url, "down")).toEqual(["Migration20261023000000InitialSchema"]);
    expect(await userTables(url)).toEqual([]);

    expect(await migrate(url, "up")).toEqual(["Migration20261023000000InitialSchema"]);
    expect(await userTables(url)).toEqual(TABLES);

    expect(await migrate(url, "up")).toEqual([]);
  }, 30_000);
});
