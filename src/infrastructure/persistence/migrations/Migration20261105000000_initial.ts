import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema. Uniqueness, immutability and non-negativity live here (§5 of the challenge),
 * not only in application code. See ARCHITECTURE.md §5 for the rationale of each object.
 */
export class Migration20261105000000_initial extends Migration {
  override name = "Migration20261105000000_initial";

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   varchar(128)   NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20,2)  NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq       UNIQUE (id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_player_not_blank     CHECK (length(player_id) > 0)
      )`);

    // ---------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(128)   NOT NULL,
        external_transaction_id            varchar(128)   NOT NULL,
        idempotency_key                    varchar(255)   NOT NULL,
        payload_hash                       char(64)       NOT NULL,
        wallet_id                          uuid           NOT NULL REFERENCES wallets (id),
        player_id                          varchar(128)   NOT NULL,
        round_id                           varchar(128),
        game_id                            varchar(128),
        kind                               varchar(16)    NOT NULL,
        amount                             numeric(20,2)  NOT NULL,
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid,
        status                             varchar(24)    NOT NULL,
        failure_code                       varchar(64),
        resulting_balance                  numeric(20,2),
        resulting_balance_currency         char(3),
        reference_attempts                 integer        NOT NULL DEFAULT 0,
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz    NOT NULL,
        CONSTRAINT wager_tx_idempotency_key_uq  UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_id_wallet_uq        UNIQUE (id, wallet_id),
        -- A reference always lives in the same wallet (single wallet lock covers both rows).
        CONSTRAINT wager_tx_reference_same_wallet_fk
          FOREIGN KEY (reference_transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_tx_currency_format     CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_amount_positive_unless_loss CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_bet_without_reference
          CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_internal_provider_only_for_opening CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_tx_round_and_game_required
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_tx_reference_id_needs_external_reference
          CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_processed_complete
          CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND resulting_balance IS NOT NULL)),
        CONSTRAINT wager_tx_failure_code_iff_failed
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_terminal_has_processed_at
          CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_pending_reference_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL),
        CONSTRAINT wager_tx_resulting_balance_pair
          CHECK ((resulting_balance IS NULL) = (resulting_balance_currency IS NULL)),
        CONSTRAINT wager_tx_resulting_balance_non_negative CHECK (resulting_balance IS NULL OR resulting_balance >= 0),
        CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      )`);
    // A transaction is reversed at most once, by REFUND or ROLLBACK (A4).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_by_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE FUNCTION wager_tx_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot return to PENDING', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'immutable columns of wager transaction % cannot change', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_update BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_update()`);
    this.addSql(`
      CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is forbidden (append-only / auditable table)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_forbid_delete BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_modification()`);
    this.addSql(`
      CREATE TRIGGER wager_tx_forbid_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification()`);

    // ------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        transaction_id  uuid           NOT NULL,
        direction       varchar(6)     NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        balance_before  numeric(20,2)  NOT NULL,
        balance_after   numeric(20,2)  NOT NULL,
        wallet_version  integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        -- Entry currency is the wallet currency.
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        -- The transaction belongs to the same wallet.
        CONSTRAINT ledger_transaction_same_wallet_fk
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        -- At most one entry per financial transaction (§6.4).
        CONSTRAINT ledger_transaction_uq UNIQUE (transaction_id),
        -- One entry per wallet version: stable ordering and a second guard against lost updates.
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ledger_arithmetic CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)
      )`);
    this.addSql(`
      CREATE TRIGGER ledger_forbid_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_modification()`);
    this.addSql(`
      CREATE TRIGGER ledger_forbid_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification()`);

    // Chain: each entry continues the previous one of the same wallet.
    this.addSql(`
      CREATE FUNCTION ledger_check_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous RECORD;
      BEGIN
        SELECT wallet_version, balance_after INTO previous
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          -- First entry: opening credit (version 1) or first movement of a zero-opened wallet (version 2).
          IF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start from 0 at version 1 or 2', NEW.wallet_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.wallet_version <> previous.wallet_version + 1 OR NEW.balance_before <> previous.balance_after THEN
          RAISE EXCEPTION 'ledger entry of wallet % breaks the chain (expected version % from balance %)',
            NEW.wallet_id, previous.wallet_version + 1, previous.balance_after
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_check_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_check_chain()`);

    // Balance <-> ledger, checked at commit (deferred): every balance/version change has its entry,
    // and every entry is reflected in the materialized balance.
    this.addSql(`
      CREATE FUNCTION wallet_check_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_wallet RECORD;
        latest RECORD;
      BEGIN
        SELECT version, balance INTO current_wallet FROM wallets WHERE id = NEW.id;
        SELECT wallet_version, balance_after INTO latest
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          IF current_wallet.version <> 1 OR current_wallet.balance <> 0 THEN
            RAISE EXCEPTION 'wallet % has balance % at version % without ledger entries',
              NEW.id, current_wallet.balance, current_wallet.version USING ERRCODE = 'check_violation';
          END IF;
        ELSIF latest.wallet_version <> current_wallet.version OR latest.balance_after <> current_wallet.balance THEN
          RAISE EXCEPTION 'wallet % (version %, balance %) diverges from its ledger (version %, balance %)',
            NEW.id, current_wallet.version, current_wallet.balance, latest.wallet_version, latest.balance_after
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_check_ledger AFTER INSERT OR UPDATE OF balance, version ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_check_ledger()`);
    this.addSql(`
      CREATE FUNCTION ledger_check_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        current_wallet RECORD;
        latest_version integer;
      BEGIN
        SELECT version, balance INTO current_wallet FROM wallets WHERE id = NEW.wallet_id;
        SELECT max(wallet_version) INTO latest_version FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id;
        IF latest_version <> current_wallet.version THEN
          RAISE EXCEPTION 'ledger of wallet % reaches version % but wallet is at version %',
            NEW.wallet_id, latest_version, current_wallet.version USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.wallet_version = current_wallet.version AND NEW.balance_after <> current_wallet.balance THEN
          RAISE EXCEPTION 'ledger entry % (balance %) is not reflected in wallet % (balance %)',
            NEW.id, NEW.balance_after, NEW.wallet_id, current_wallet.balance USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_check_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_wallet()`);

    // ---------------------------------------------------------------- outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     varchar(128)  NOT NULL,
        event_type       varchar(64)   NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_pending_is_scheduled CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL`);
    this.addSql(`
      CREATE FUNCTION outbox_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % content is immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox message % was already published', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER outbox_guard_update BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard_update()`);

    // ----------------------------------------------------------------- inbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(64)   NOT NULL,
        message_id     varchar(128)  NOT NULL,
        payload_hash   char(64)      NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      )`);
    this.addSql(`
      CREATE FUNCTION inbox_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.consumer_name, NEW.message_id, NEW.payload_hash, NEW.received_at)
           IS DISTINCT FROM (OLD.consumer_name, OLD.message_id, OLD.payload_hash, OLD.received_at)
           OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at) THEN
          RAISE EXCEPTION 'inbox message %/% is immutable', OLD.consumer_name, OLD.message_id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER inbox_guard_update BEFORE UPDATE ON inbox_messages
        FOR EACH ROW EXECUTE FUNCTION inbox_guard_update()`);
  }

  override down(): void {
    this.addSql("DROP TABLE IF EXISTS inbox_messages");
    this.addSql("DROP FUNCTION IF EXISTS inbox_guard_update()");
    this.addSql("DROP TABLE IF EXISTS outbox_messages");
    this.addSql("DROP FUNCTION IF EXISTS outbox_guard_update()");
    this.addSql("DROP TABLE IF EXISTS wallet_ledger_entries");
    this.addSql("DROP FUNCTION IF EXISTS ledger_check_wallet()");
    this.addSql("DROP FUNCTION IF EXISTS ledger_check_chain()");
    this.addSql("DROP TABLE IF EXISTS wager_transactions");
    this.addSql("DROP FUNCTION IF EXISTS wager_tx_guard_update()");
    this.addSql("DROP TABLE IF EXISTS wallets");
    this.addSql("DROP FUNCTION IF EXISTS wallet_check_ledger()");
    this.addSql("DROP FUNCTION IF EXISTS forbid_modification()");
  }
}
