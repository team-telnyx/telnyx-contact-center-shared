-- Fix existing queue activation data
-- This script clears deactivated_at for all currently active queue assignments
-- where enabled = true but deactivated_at is not null

UPDATE cc_queue_user_assignments
SET deactivated_at = NULL,
    updated_at = NOW()
WHERE enabled = true
  AND deactivated_at IS NOT NULL;

-- Verify the fix
SELECT 
  user_id,
  queue_id,
  enabled,
  activated_at,
  deactivated_at,
  CASE 
    WHEN enabled = true 
      AND activated_at IS NOT NULL 
      AND deactivated_at IS NULL 
    THEN 'ACTIVE' 
    WHEN enabled = false 
      AND deactivated_at IS NOT NULL 
    THEN 'DEACTIVATED'
    ELSE 'INVALID STATE'
  END as status
FROM cc_queue_user_assignments
ORDER BY user_id, queue_id;
