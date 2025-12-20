-- Drop the check constraint on cc_agent_state.agent_status if it exists
-- This allows custom statuses from cc_user_statuses table

DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'cc_agent_state_agent_status_check'
    AND conrelid = 'cc_agent_state'::regclass
  ) THEN
    ALTER TABLE cc_agent_state DROP CONSTRAINT cc_agent_state_agent_status_check;
    RAISE NOTICE 'Dropped constraint cc_agent_state_agent_status_check';
  ELSE
    RAISE NOTICE 'Constraint cc_agent_state_agent_status_check does not exist';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Error: %', SQLERRM;
END $$;
