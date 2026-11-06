import { Migration } from "@mikro-orm/migrations";

/**
 * Defense in depth (§6.4): a ledger entry must describe its transaction.
 * The application already guarantees it; this trigger makes it true even for a bug or a manual write.
 *
 * On INSERT into wallet_ledger_entries, the referenced wager transaction must:
 *   - already be PROCESSED (REJECTED / FAILED / pending transactions never move the balance);
 *   - not be a LOSS (LOSS records a result without a ledger effect);
 *   - have the same amount and currency as the entry;
 *   - match the direction of its kind: BET → DEBIT; WIN / REFUND / OPENING → CREDIT;
 *     ROLLBACK → the opposite of the transaction it reverses (BET → CREDIT; WIN / REFUND → DEBIT).
 * AFTER INSERT, row level and immediate (not deferred): it runs after the table's own constraints and
 * foreign keys, aborts the statement, and every flow persists the final status before the entry.
 */
export class Migration20261106000000_ledger_matches_transaction extends Migration {
  override name = "Migration20261106000000_ledger_matches_transaction";

  override up(): void {
    this.addSql(`
      CREATE FUNCTION ledger_check_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx        record;
        ref_kind  varchar(16);
        expected  varchar(6);
      BEGIN
        SELECT kind, status, amount, currency, reference_transaction_id INTO tx
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ledger entry % references unknown transaction %', NEW.id, NEW.transaction_id
            USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF tx.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'ledger entry % for transaction % in status % (only PROCESSED moves the balance)',
            NEW.id, NEW.transaction_id, tx.status USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF tx.amount <> NEW.amount OR tx.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % amount/currency differs from transaction %', NEW.id, NEW.transaction_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF tx.kind = 'ROLLBACK' THEN
          SELECT kind INTO ref_kind FROM wager_transactions WHERE id = tx.reference_transaction_id;
          expected := CASE ref_kind WHEN 'BET' THEN 'CREDIT' WHEN 'WIN' THEN 'DEBIT' WHEN 'REFUND' THEN 'DEBIT' END;
        ELSE
          expected := CASE tx.kind WHEN 'BET' THEN 'DEBIT' WHEN 'WIN' THEN 'CREDIT'
                                   WHEN 'REFUND' THEN 'CREDIT' WHEN 'OPENING' THEN 'CREDIT' END;
        END IF;
        IF expected IS NULL OR NEW.direction <> expected THEN
          RAISE EXCEPTION 'ledger entry % direction % is not valid for % transaction %',
            NEW.id, NEW.direction, tx.kind, NEW.transaction_id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_check_transaction AFTER INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction()`);
  }

  override down(): void {
    this.addSql("DROP TRIGGER IF EXISTS ledger_check_transaction ON wallet_ledger_entries");
    this.addSql("DROP FUNCTION IF EXISTS ledger_check_transaction()");
  }
}
