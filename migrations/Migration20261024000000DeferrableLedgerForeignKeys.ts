import { Migration } from "@mikro-orm/migrations";

/**
 * The Unit of Work flushes all inserts of a transaction together and does not guarantee their order.
 * Checking these foreign keys at commit makes the result independent of insert order.
 */
export class Migration20261024000000DeferrableLedgerForeignKeys extends Migration {
  override name = "Migration20261024000000DeferrableLedgerForeignKeys";

  override up(): void {
    this.addSql(`alter table wallet_ledger_entries alter constraint fk_ledger_wallet_currency deferrable initially deferred;`);
    this.addSql(`alter table wallet_ledger_entries alter constraint fk_ledger_transaction_wallet deferrable initially deferred;`);
    this.addSql(`alter table wager_transactions alter constraint fk_wtx_reference deferrable initially deferred;`);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions alter constraint fk_wtx_reference not deferrable;`);
    this.addSql(`alter table wallet_ledger_entries alter constraint fk_ledger_transaction_wallet not deferrable;`);
    this.addSql(`alter table wallet_ledger_entries alter constraint fk_ledger_wallet_currency not deferrable;`);
  }
}
