// Shared by application upgrades and integration fixtures. Core cancellation
// and suppression are terminal outcomes even when no customer leg was created.
export const OUTBOUND_DIAL_STATE_UPGRADE = `
  ALTER TABLE outbound_attempt_ledger ADD COLUMN IF NOT EXISTS dial_state TEXT NOT NULL DEFAULT 'pending';
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='outbound_attempt_ledger'::regclass
      AND conname='outbound_attempt_ledger_dial_state_check'
      AND position('cancelled' in pg_get_constraintdef(oid))>0
      AND position('skipped' in pg_get_constraintdef(oid))>0
      AND position('suppressed' in pg_get_constraintdef(oid))>0) THEN
      ALTER TABLE outbound_attempt_ledger DROP CONSTRAINT IF EXISTS outbound_attempt_ledger_dial_state_check;
      ALTER TABLE outbound_attempt_ledger ADD CONSTRAINT outbound_attempt_ledger_dial_state_check CHECK (dial_state IN (
        'pending','dialing','ringing','human','machine','no_answer','busy','failed',
        'connecting','connected','wrapup','disposed','abandoned','voicemail_action',
        'retry','exhausted','cancelled','skipped','suppressed'));
    END IF;
  END $$;
`;
