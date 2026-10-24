import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { expectConstraint, prepareTestDatabase } from "../../support/database.ts";

type Tx = SQL;

let sql: SQL;

beforeAll(async () => {
  sql = new SQL(await prepareTestDatabase(), { max: 5 });
});

afterAll(async () => {
  await sql?.close();
});

const uuid = () => crypto.randomUUID();
const hash = () => new Bun.CryptoHasher("sha256").update(uuid()).digest("hex");

interface TxRow {
  id?: string;
  providerId?: string;
  externalId?: string;
  walletId: string;
  playerId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  status?: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  referenceExternalId?: string | null;
  referenceId?: string | null;
}

async function insertTransaction(tx: Tx, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const kind = row.kind ?? "BET";
  const providerId = row.providerId ?? (kind === "OPENING" ? "internal" : "provider-a");
  const externalId = row.externalId ?? `ext-${id}`;
  const status = row.status ?? "PROCESSED";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(status);
  await tx`
    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, balance_after_amount, next_retry_at, created_at, processed_at
    ) values (
      ${id}, ${providerId}, ${externalId}, ${`${providerId}:${externalId}`}, ${hash()}, ${row.walletId}, ${row.playerId},
      'round-1', 'game-1', ${kind}, ${row.amount ?? "10.00"}, ${row.currency ?? "BRL"},
      ${row.referenceExternalId ?? null}, ${row.referenceId ?? null},
      ${status}, ${row.failureCode ?? null},
      ${row.balanceAfter === undefined ? (status === "PROCESSED" ? "0.00" : null) : row.balanceAfter},
      ${status === "PENDING_REFERENCE" ? new Date() : null}, now(), ${terminal ? new Date() : null}
    )`;
  return id;
}

interface LedgerRow {
  walletId: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  before: string;
  after: string;
  sequence: number;
  currency?: string;
}

async function insertLedger(tx: Tx, row: LedgerRow): Promise<string> {
  const id = uuid();
  await tx`
    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency,
      balance_before_amount, balance_after_amount, sequence, created_at
    ) values (
      ${id}, ${row.walletId}, ${row.transactionId}, ${row.direction}, ${row.amount}, ${row.currency ?? "BRL"},
      ${row.before}, ${row.after}, ${row.sequence}, now()
    )`;
  return id;
}

async function insertWallet(tx: Tx, balance: string, version = 1, playerId = uuid(), currency = "BRL") {
  const id = uuid();
  await tx`
    insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
    values (${id}, ${playerId}, ${currency}, ${balance}, ${version}, now(), now())`;
  return { id, playerId };
}

/** A consistent wallet: OPENING transaction + CREDIT entry at sequence 1, committed. */
async function openWallet(balance = "100.00") {
  return sql.begin(async (tx) => {
    const wallet = await insertWallet(tx, balance);
    const openingId = await insertTransaction(tx, {
      ...wallet,
      walletId: wallet.id,
      kind: "OPENING",
      amount: balance,
      balanceAfter: balance,
      externalId: `opening:${wallet.id}`,
    });
    const entryId = await insertLedger(tx, {
      walletId: wallet.id,
      transactionId: openingId,
      direction: "CREDIT",
      amount: balance,
      before: "0.00",
      after: balance,
      sequence: 1,
    });
    return { walletId: wallet.id, playerId: wallet.playerId, openingId, entryId };
  });
}

/** Applies a processed BET of `amount` against a wallet currently at (balance, version). */
async function debit(walletId: string, playerId: string, amount: string, balance: string, version: number) {
  const after = (Number(balance) - Number(amount)).toFixed(2); // test-only arithmetic on known small values
  return sql.begin(async (tx) => {
    const txId = await insertTransaction(tx, { walletId, playerId, amount, balanceAfter: after });
    await insertLedger(tx, {
      walletId,
      transactionId: txId,
      direction: "DEBIT",
      amount,
      before: balance,
      after,
      sequence: version + 1,
    });
    await tx`update wallets set balance_amount = ${after}, version = ${version + 1}, updated_at = now() where id = ${walletId}`;
    return txId;
  });
}

describe("wallets", () => {
  test("a consistent wallet with OPENING entry commits", async () => {
    const { walletId } = await openWallet("100.00");
    const [wallet] = await sql`select balance_amount, version from wallets where id = ${walletId}`;
    expect(wallet).toEqual({ balance_amount: "100.00", version: 1 });
  });

  test("a wallet opened with zero balance needs no ledger entry", async () => {
    await sql.begin((tx) => insertWallet(tx, "0.00"));
  });

  test("balance cannot be negative", async () => {
    await expectConstraint(sql.begin((tx) => insertWallet(tx, "-0.01")), "ck_wallets_balance_non_negative");
  });

  test("at most one wallet per player and currency", async () => {
    const playerId = uuid();
    await sql.begin((tx) => insertWallet(tx, "0.00", 1, playerId));
    await expectConstraint(sql.begin((tx) => insertWallet(tx, "0.00", 1, playerId)), "uq_wallets_player_currency");
    await sql.begin((tx) => insertWallet(tx, "0.00", 1, playerId, "USD"));
  });

  test("a positive balance without ledger entry is rejected at commit", async () => {
    await expectConstraint(sql.begin((tx) => insertWallet(tx, "50.00")), "wallets_assert_ledger");
  });

  test("changing the balance without a ledger entry is rejected at commit", async () => {
    const { walletId } = await openWallet("100.00");
    await expectConstraint(
      sql`update wallets set balance_amount = 90.00, version = 2 where id = ${walletId}`,
      "wallets_assert_ledger",
    );
  });

  test("changing the balance without bumping the version is rejected", async () => {
    const { walletId } = await openWallet("100.00");
    await expectConstraint(sql`update wallets set balance_amount = 90.00 where id = ${walletId}`, "wallets_guard");
  });

  test("version cannot jump", async () => {
    const { walletId } = await openWallet("100.00");
    await expectConstraint(
      sql`update wallets set balance_amount = 90.00, version = 3 where id = ${walletId}`,
      "wallets_guard",
    );
  });

  test("identity fields are immutable and wallets are never deleted", async () => {
    const { walletId } = await openWallet("100.00");
    await expectConstraint(sql`update wallets set currency = 'USD' where id = ${walletId}`, "wallets_guard");
    await expectConstraint(sql`update wallets set player_id = ${uuid()} where id = ${walletId}`, "wallets_guard");
    await expectConstraint(sql`delete from wallets where id = ${walletId}`, "wallets_guard");
  });

  test("a full debit flow commits and keeps balance == ledger", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await debit(walletId, playerId, "80.00", "100.00", 1);

    const [wallet] = await sql`select balance_amount, version from wallets where id = ${walletId}`;
    const [ledger] = await sql`
      select sum(case direction when 'CREDIT' then amount else -amount end)::numeric(20, 2) as balance, count(*)::int as entries
      from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(wallet).toEqual({ balance_amount: "20.00", version: 2 });
    expect(ledger).toEqual({ balance: "20.00", entries: 2 });
  });
});

describe("wallet_ledger_entries", () => {
  test("entries cannot be updated, deleted or truncated", async () => {
    const { entryId } = await openWallet();
    await expectConstraint(sql`update wallet_ledger_entries set amount = 1 where id = ${entryId}`, "ledger_append_only");
    await expectConstraint(sql`delete from wallet_ledger_entries where id = ${entryId}`, "ledger_append_only");
    await expectConstraint(sql`truncate wallet_ledger_entries cascade`, "ledger_append_only");
  });

  test("arithmetic must balance", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId, amount: "10.00" });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "95.00", sequence: 2 });
      }),
      "ck_ledger_balanced",
    );
  });

  test("an entry must continue the previous balance", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId, amount: "10.00" });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "50.00", after: "40.00", sequence: 2 });
      }),
      "ledger_chain",
    );
  });

  test("sequences cannot leave gaps", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId, amount: "10.00" });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", sequence: 3 });
      }),
      "ledger_chain",
    );
  });

  test("at most one entry per transaction", async () => {
    const { walletId, openingId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin((tx) =>
        insertLedger(tx, { walletId, transactionId: openingId, direction: "CREDIT", amount: "1.00", before: "100.00", after: "101.00", sequence: 2 }),
      ),
      "uq_ledger_transaction",
    );
  });

  test("the entry currency must be the wallet currency", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId, amount: "10.00", currency: "USD" });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", sequence: 2, currency: "USD" });
      }),
      "fk_ledger_wallet_currency",
    );
  });

  test("the transaction must belong to the same wallet", async () => {
    const first = await openWallet("100.00");
    const second = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId: second.walletId, playerId: second.playerId });
        await insertLedger(tx, { walletId: first.walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", sequence: 2 });
      }),
      "fk_ledger_transaction_wallet",
    );
  });

  test.each([
    ["a LOSS", { kind: "LOSS", status: "PROCESSED" }],
    ["a REJECTED transaction", { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" }],
  ])("%s cannot have a ledger entry", async (_label, override) => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId, ...override });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", sequence: 2 });
        await tx`update wallets set balance_amount = 90.00, version = 2 where id = ${walletId}`;
      }),
      "ledger_transaction_processed",
    );
  });

  test("an entry ahead of the wallet version is rejected at commit", async () => {
    const { walletId, playerId } = await openWallet("100.00");
    await expectConstraint(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx, { walletId, playerId });
        await insertLedger(tx, { walletId, transactionId: txId, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", sequence: 2 });
      }),
      "ledger_wallet_version",
    );
  });
});

describe("wager_transactions", () => {
  const ids = () => ({ walletId: uuid(), playerId: uuid() });

  test("idempotency key and (provider, external id) are unique", async () => {
    const owner = ids();
    const externalId = `dup-${uuid()}`;
    await sql.begin((tx) => insertTransaction(tx, { ...owner, externalId, status: "PENDING", balanceAfter: null }));
    await expectConstraint(
      sql.begin((tx) => insertTransaction(tx, { ...owner, externalId, status: "PENDING", balanceAfter: null })),
      "uq_wtx_idempotency_key",
    );
    await expectConstraint(
      sql.begin(async (tx) => {
        await tx`
          insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, created_at)
          values (${uuid()}, 'provider-a', ${externalId}, ${`another-key-${uuid()}`}, ${hash()}, ${owner.walletId}, ${owner.playerId},
            'r', 'g', 'BET', 1, 'BRL', 'PENDING', now())`;
      }),
      "uq_wtx_provider_external",
    );
  });

  test.each([
    ["REFUND without reference", { kind: "REFUND", status: "PENDING", balanceAfter: null }, "ck_wtx_reference_required"],
    ["BET with reference", { kind: "BET", referenceExternalId: "x" }, "ck_wtx_bet_has_no_reference"],
    ["OPENING from a provider", { kind: "OPENING", providerId: "provider-a" }, "ck_wtx_opening_is_internal"],
    ["BET using the internal provider", { kind: "BET", providerId: "internal" }, "ck_wtx_opening_is_internal"],
    ["REJECTED without failure code", { status: "REJECTED" }, "ck_wtx_failure_code"],
    ["PROCESSED with failure code", { status: "PROCESSED", failureCode: "INSUFFICIENT_FUNDS" }, "ck_wtx_failure_code"],
    ["PROCESSED without observed balance", { status: "PROCESSED", balanceAfter: null }, "ck_wtx_processed_has_balance"],
    ["BET of zero", { amount: "0.00" }, "ck_wtx_amount_positive"],
    ["processed REFUND without resolved reference", { kind: "REFUND", referenceExternalId: "x" }, "ck_wtx_processed_reversal_has_reference"],
  ])("rejects %s", async (_label, override, constraint) => {
    await expectConstraint(sql.begin((tx) => insertTransaction(tx, { ...ids(), ...override })), constraint);
  });

  test("LOSS of zero is allowed", async () => {
    await sql.begin((tx) => insertTransaction(tx, { ...ids(), kind: "LOSS", amount: "0.00" }));
  });

  test("terminal transactions never change", async () => {
    const id = await sql.begin((tx) => insertTransaction(tx, { ...ids(), status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" }));
    await expectConstraint(
      sql`update wager_transactions set status = 'PROCESSED', failure_code = null, balance_after_amount = 1 where id = ${id}`,
      "wager_transactions_guard",
    );
  });

  test("business fields are immutable even before the transaction is terminal", async () => {
    const id = await sql.begin((tx) => insertTransaction(tx, { ...ids(), status: "PENDING", balanceAfter: null }));
    await expectConstraint(sql`update wager_transactions set amount = 999 where id = ${id}`, "wager_transactions_guard");
  });

  test("a pending transaction can move to a terminal state", async () => {
    const id = await sql.begin((tx) =>
      insertTransaction(tx, { ...ids(), kind: "REFUND", referenceExternalId: "bet-x", status: "PENDING_REFERENCE", balanceAfter: null }),
    );
    await sql`
      update wager_transactions
      set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', processed_at = now(), next_retry_at = null
      where id = ${id}`;
  });

  test("rows are never deleted", async () => {
    const id = await sql.begin((tx) => insertTransaction(tx, { ...ids(), status: "PENDING", balanceAfter: null }));
    await expectConstraint(sql`delete from wager_transactions where id = ${id}`, "wager_transactions_guard");
  });

  test("a transaction can be reverted only once, by any kind", async () => {
    const owner = ids();
    const betId = await sql.begin((tx) => insertTransaction(tx, { ...owner, externalId: `bet-${uuid()}` }));
    const reversal = (kind: string) =>
      sql.begin((tx) => insertTransaction(tx, { ...owner, kind, referenceExternalId: "bet", referenceId: betId }));

    await reversal("REFUND");
    await expectConstraint(reversal("REFUND"), "uq_wtx_single_reversal");
    await expectConstraint(reversal("ROLLBACK"), "uq_wtx_single_reversal");
  });

  test("a rejected reversal does not consume the single reversal slot", async () => {
    const owner = ids();
    const betId = await sql.begin((tx) => insertTransaction(tx, { ...owner }));
    await sql.begin((tx) =>
      insertTransaction(tx, { ...owner, kind: "REFUND", referenceExternalId: "bet", referenceId: betId, status: "REJECTED", failureCode: "AMOUNT_MISMATCH" }),
    );
    await sql.begin((tx) => insertTransaction(tx, { ...owner, kind: "REFUND", referenceExternalId: "bet", referenceId: betId }));
  });
});

describe("inbox_messages", () => {
  test("(consumer, message id) is unique; the same message id is allowed for another consumer", async () => {
    const messageId = uuid();
    const insert = (consumer: string) =>
      sql`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (${consumer}, ${messageId}, ${hash()}, now())`;
    await insert("wager-consumer");
    await expectConstraint(insert("wager-consumer"), "pk_inbox_messages");
    await insert("another-consumer");
  });
});

describe("outbox_messages", () => {
  async function insertOutbox(id = uuid(), eventType = "WalletBalanceChanged", payloadEventId = id) {
    await sql`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
      values (${id}, ${uuid()}, ${eventType}, ${{ eventId: payloadEventId, eventType }}, now(), now())`;
    return id;
  }

  test("payload must match the row's event id and type", async () => {
    await expectConstraint(insertOutbox(uuid(), "WalletBalanceChanged", uuid()), "ck_outbox_payload_matches");
  });

  test("the event payload is immutable", async () => {
    const id = await insertOutbox();
    await expectConstraint(
      sql`update outbox_messages set payload = ${{ eventId: id, eventType: "WalletBalanceChanged", tampered: true }} where id = ${id}`,
      "outbox_guard",
    );
  });

  test("retry bookkeeping can change; a published event stays published", async () => {
    const id = await insertOutbox();
    await sql`update outbox_messages set attempts = attempts + 1, next_attempt_at = now() + interval '1 second' where id = ${id}`;
    await sql`update outbox_messages set published_at = now() where id = ${id}`;
    await expectConstraint(sql`update outbox_messages set published_at = null where id = ${id}`, "outbox_guard");
  });

  test("rows are never deleted", async () => {
    const id = await insertOutbox();
    await expectConstraint(sql`delete from outbox_messages where id = ${id}`, "outbox_guard");
  });
});
