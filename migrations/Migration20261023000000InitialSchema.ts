import { Migration } from "@mikro-orm/migrations";

export class Migration20261023000000InitialSchema extends Migration {
  override name = "Migration20261023000000InitialSchema";

  override up(): void {
    this.wallets();
    this.wagerTransactions();
    this.ledger();
    this.messaging();
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists outbox_guard();`);
    this.addSql(`drop function if exists ledger_assert_wallet_and_transaction();`);
    this.addSql(`drop function if exists ledger_assert_chain();`);
    this.addSql(`drop function if exists ledger_forbid_mutation();`);
    this.addSql(`drop function if exists wager_transactions_guard();`);
    this.addSql(`drop function if exists wallets_assert_ledger();`);
    this.addSql(`drop function if exists wallets_forbid_delete();`);
    this.addSql(`drop function if exists wallets_guard();`);
  }

  private wallets(): void {
    this.addSql(`
      create table wallets (
        id              uuid           primary key,
        player_id       uuid           not null,
        currency        char(3)        not null constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(20, 2) not null constraint ck_wallets_balance_non_negative check (balance_amount >= 0),
        version         integer        not null constraint ck_wallets_version_positive check (version >= 1),
        created_at      timestamptz    not null,
        updated_at      timestamptz    not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        -- target of composite foreign keys that pin the currency of ledger entries
        constraint uq_wallets_id_currency unique (id, currency)
      );
    `);

    // Identity is immutable and the version moves exactly when the balance moves.
    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallets: id, player_id, currency and created_at are immutable'
            using errcode = 'check_violation', constraint = 'wallets_guard';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallets: a balance change must increment version by exactly 1'
            using errcode = 'check_violation', constraint = 'wallets_guard';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallets: version only changes together with the balance'
            using errcode = 'check_violation', constraint = 'wallets_guard';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_wallets_guard before update on wallets
        for each row execute function wallets_guard();
    `);
    this.addSql(`
      create function wallets_forbid_delete() returns trigger language plpgsql as $$
      begin
        raise exception 'wallets: rows cannot be deleted'
          using errcode = 'check_violation', constraint = 'wallets_guard';
      end $$;
    `);
    this.addSql(`
      create trigger trg_wallets_no_delete before delete on wallets
        for each row execute function wallets_forbid_delete();
    `);

    // Checked at commit: the materialized balance must equal the ledger entry produced at this version.
    this.addSql(`
      create function wallets_assert_ledger() returns trigger language plpgsql as $$
      begin
        if new.version = 1 and new.balance_amount = 0 then
          return null;
        end if;
        if not exists (
          select 1 from wallet_ledger_entries e
          where e.wallet_id = new.id and e.sequence = new.version and e.balance_after_amount = new.balance_amount
        ) then
          raise exception 'wallets: balance % at version % has no matching ledger entry', new.balance_amount, new.version
            using errcode = 'check_violation', constraint = 'wallets_assert_ledger';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger trg_wallets_assert_ledger after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_assert_ledger();
    `);
  }

  private wagerTransactions(): void {
    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        varchar(100)   not null constraint ck_wtx_provider_not_blank check (btrim(provider_id) <> ''),
        external_transaction_id            varchar(200)   not null constraint ck_wtx_external_id_not_blank check (btrim(external_transaction_id) <> ''),
        idempotency_key                    varchar(300)   not null,
        payload_hash                       char(64)       not null constraint ck_wtx_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
        -- no foreign key: requests for unknown wallets are persisted as REJECTED (WALLET_NOT_FOUND) for replay
        wallet_id                          uuid           not null,
        player_id                          uuid           not null,
        round_id                           varchar(200)   not null,
        game_id                            varchar(200)   not null,
        kind                               varchar(20)    not null constraint ck_wtx_kind
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) not null constraint ck_wtx_amount_non_negative check (amount >= 0),
        currency                           char(3)        not null constraint ck_wtx_currency check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid           constraint fk_wtx_reference references wager_transactions (id),
        status                             varchar(20)    not null constraint ck_wtx_status
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       varchar(50),
        balance_after_amount               numeric(20, 2) constraint ck_wtx_balance_after_non_negative check (balance_after_amount >= 0),
        reference_attempts                 integer        not null default 0 constraint ck_wtx_attempts check (reference_attempts >= 0),
        next_retry_at                      timestamptz,
        created_at                         timestamptz    not null,
        processed_at                       timestamptz,

        constraint uq_wtx_idempotency_key unique (idempotency_key),
        constraint uq_wtx_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wtx_id_wallet unique (id, wallet_id),

        constraint ck_wtx_amount_positive check (kind = 'LOSS' or amount > 0),
        constraint ck_wtx_reference_required check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wtx_bet_has_no_reference check (kind <> 'BET' or reference_external_transaction_id is null),
        constraint ck_wtx_opening_is_internal check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint ck_wtx_failure_code check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint ck_wtx_terminal_has_processed_at check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint ck_wtx_processed_has_balance check (status <> 'PROCESSED' or balance_after_amount is not null),
        constraint ck_wtx_processed_reversal_has_reference check (
          status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null
        ),
        constraint ck_wtx_pending_reference_scheduled check (status <> 'PENDING_REFERENCE' or next_retry_at is not null)
      );
    `);

    // A transaction can be reverted (REFUND or ROLLBACK) at most once.
    this.addSql(`
      create unique index uq_wtx_single_reversal on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`create index ix_wtx_dependents on wager_transactions (reference_transaction_id) where reference_transaction_id is not null;`);
    this.addSql(`create index ix_wtx_pending_reference_due on wager_transactions (next_retry_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(`
      create index ix_wtx_pending_by_reference on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index ix_wtx_wallet_created on wager_transactions (wallet_id, created_at);`);

    // Business fields never change; terminal states are final; rows are never deleted.
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions: rows cannot be deleted'
            using errcode = 'check_violation', constraint = 'wager_transactions_guard';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transactions: % is terminal and cannot change', old.status
            using errcode = 'check_violation', constraint = 'wager_transactions_guard';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager_transactions: business fields are immutable'
            using errcode = 'check_violation', constraint = 'wager_transactions_guard';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_wager_transactions_guard before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);
  }

  private ledger(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id                     uuid           primary key,
        wallet_id              uuid           not null,
        transaction_id         uuid           not null,
        direction              varchar(6)     not null constraint ck_ledger_direction check (direction in ('DEBIT', 'CREDIT')),
        amount                 numeric(20, 2) not null constraint ck_ledger_amount_positive check (amount > 0),
        currency               char(3)        not null,
        balance_before_amount  numeric(20, 2) not null constraint ck_ledger_before_non_negative check (balance_before_amount >= 0),
        balance_after_amount   numeric(20, 2) not null constraint ck_ledger_after_non_negative check (balance_after_amount >= 0),
        sequence               integer        not null constraint ck_ledger_sequence_positive check (sequence >= 1),
        created_at             timestamptz    not null,

        constraint fk_ledger_wallet_currency foreign key (wallet_id, currency) references wallets (id, currency),
        constraint fk_ledger_transaction_wallet foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint uq_ledger_transaction unique (transaction_id),
        constraint uq_ledger_wallet_sequence unique (wallet_id, sequence),
        constraint ck_ledger_balanced check (
          (direction = 'CREDIT' and balance_after_amount = balance_before_amount + amount) or
          (direction = 'DEBIT'  and balance_after_amount = balance_before_amount - amount)
        )
      );
    `);

    this.addSql(`
      create function ledger_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% not allowed)', tg_op
          using errcode = 'check_violation', constraint = 'ledger_append_only';
      end $$;
    `);
    this.addSql(`
      create trigger trg_ledger_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();
    `);
    this.addSql(`
      create trigger trg_ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_forbid_mutation();
    `);

    // Each entry continues the previous one: balance_before = previous balance_after, no gaps.
    this.addSql(`
      create function ledger_assert_chain() returns trigger language plpgsql as $$
      declare
        previous_after numeric(20, 2);
        has_earlier boolean;
      begin
        select e.balance_after_amount into previous_after
          from wallet_ledger_entries e
          where e.wallet_id = new.wallet_id and e.sequence = new.sequence - 1;

        if found then
          if new.balance_before_amount <> previous_after then
            raise exception 'wallet_ledger_entries: balance_before % does not continue previous balance_after %',
              new.balance_before_amount, previous_after
              using errcode = 'check_violation', constraint = 'ledger_chain';
          end if;
          return new;
        end if;

        select exists (select 1 from wallet_ledger_entries e where e.wallet_id = new.wallet_id) into has_earlier;
        if has_earlier then
          raise exception 'wallet_ledger_entries: sequence % leaves a gap', new.sequence
            using errcode = 'check_violation', constraint = 'ledger_chain';
        end if;
        if new.balance_before_amount <> 0 then
          raise exception 'wallet_ledger_entries: first entry must start from zero'
            using errcode = 'check_violation', constraint = 'ledger_chain';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_ledger_chain before insert on wallet_ledger_entries
        for each row execute function ledger_assert_chain();
    `);

    // Checked at commit: the wallet reached this version, and the transaction is a PROCESSED balance movement.
    this.addSql(`
      create function ledger_assert_wallet_and_transaction() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from wallets w where w.id = new.wallet_id and w.version >= new.sequence) then
          raise exception 'wallet_ledger_entries: wallet % never reached version %', new.wallet_id, new.sequence
            using errcode = 'check_violation', constraint = 'ledger_wallet_version';
        end if;
        if not exists (
          select 1 from wager_transactions t
          where t.id = new.transaction_id and t.status = 'PROCESSED' and t.kind <> 'LOSS'
        ) then
          raise exception 'wallet_ledger_entries: transaction % is not a processed balance movement', new.transaction_id
            using errcode = 'check_violation', constraint = 'ledger_transaction_processed';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger trg_ledger_assert_wallet_and_transaction after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function ledger_assert_wallet_and_transaction();
    `);
  }

  private messaging(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(100) not null,
        message_id     varchar(200) not null,
        payload_hash   char(64)     not null,
        received_at    timestamptz  not null,
        processed_at   timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid         primary key,
        aggregate_id     uuid         not null,
        event_type       varchar(100) not null,
        payload          jsonb        not null,
        occurred_at      timestamptz  not null,
        attempts         integer      not null default 0 constraint ck_outbox_attempts check (attempts >= 0),
        next_attempt_at  timestamptz  not null,
        locked_until     timestamptz,
        locked_by        varchar(100),
        last_error       varchar(1000),
        published_at     timestamptz,
        constraint ck_outbox_payload_matches check (
          payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type
        )
      );
    `);
    this.addSql(`create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null;`);

    // The event itself never changes, a published event stays published, and nothing is deleted.
    this.addSql(`
      create function outbox_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'outbox_messages: rows cannot be deleted'
            using errcode = 'check_violation', constraint = 'outbox_guard';
        end if;
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox_messages: the event is immutable'
            using errcode = 'check_violation', constraint = 'outbox_guard';
        end if;
        if old.published_at is not null and new.published_at is distinct from old.published_at then
          raise exception 'outbox_messages: a published event cannot be unpublished'
            using errcode = 'check_violation', constraint = 'outbox_guard';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger trg_outbox_guard before update or delete on outbox_messages
        for each row execute function outbox_guard();
    `);
  }
}
