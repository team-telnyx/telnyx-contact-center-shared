// Lifetime outcomes must survive disposition and final ledger status changes.
export const DASHBOARD_SUMMARY_SQL = `WITH attempts AS (
      SELECT
        l.*,
        (
          l.call_control_id IS NOT NULL
          OR NULLIF(l.metadata->>'dial_started_at','') IS NOT NULL
          OR (l.message_state IS NOT NULL AND l.sender_address IS NOT NULL AND l.message_state NOT IN ('pending','rendered','queued'))
          OR EXISTS (
            SELECT 1
            FROM acd_work_items w
            JOIN acd_legs leg ON leg.work_item_id=w.id AND leg.role='customer'
            WHERE w.outbound_attempt_id=l.id::text
          )
        ) AS dial_started
      FROM outbound_attempt_ledger l
      WHERE l.campaign_id = ANY($1::uuid[]) AND COALESCE(l.attempt_reason,'') <> 'test_send'
    )
    SELECT
      l.campaign_id,
      COUNT(*) FILTER (WHERE l.dial_started AND COALESCE(l.metadata->>'blending_deferred','false')<>'true')::int AS attempts_total,
      COUNT(*) FILTER (WHERE (NULLIF(l.metadata->>'connected_at','') IS NOT NULL OR EXISTS (SELECT 1 FROM acd_work_items w JOIN acd_legs leg ON leg.work_item_id=w.id AND leg.role='customer' WHERE w.outbound_attempt_id=l.id::text AND leg.bridged_at IS NOT NULL)))::int AS connected_total,
      COUNT(DISTINCT l.contact_record_id) FILTER (WHERE (NULLIF(l.metadata->>'connected_at','') IS NOT NULL OR EXISTS (SELECT 1 FROM acd_work_items w JOIN acd_legs leg ON leg.work_item_id=w.id AND leg.role='customer' WHERE w.outbound_attempt_id=l.id::text AND leg.bridged_at IS NOT NULL)))::int AS connected_records,
      COUNT(*) FILTER (WHERE l.dial_started AND COALESCE(l.metadata->>'blending_deferred','false')<>'true' AND l.created_at > NOW() - INTERVAL '15 minutes')::int AS attempts_last_15m,
      COUNT(*) FILTER (WHERE l.status = 'dialing')::int AS dialing_now,
      COUNT(*) FILTER (
        WHERE l.status IN ('dialing','answered')
           OR (
             l.status = 'claimed'
             AND COALESCE(l.lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds'
           )
      )::int AS active_now,
      COUNT(*) FILTER (WHERE (l.status = 'answered' OR NULLIF(l.metadata->>'answered_at','') IS NOT NULL OR EXISTS (SELECT 1 FROM acd_work_items w JOIN acd_legs leg ON leg.work_item_id=w.id AND leg.role='customer' WHERE w.outbound_attempt_id=l.id::text AND leg.answered_at IS NOT NULL)))::int AS answered_total,
      COUNT(*) FILTER (WHERE l.status = 'failed')::int AS failed_total,
      COUNT(*) FILTER (WHERE l.status = 'completed')::int AS completed_total,
      COUNT(DISTINCT l.contact_record_id) FILTER (WHERE l.status = 'completed')::int AS completed_records,
      COUNT(*) FILTER (WHERE COALESCE(l.metadata->>'reason_code','') IN ('answering_machine','machine','machine_detected'))::int AS machine_total,
      COUNT(*) FILTER (WHERE COALESCE(l.metadata->>'reason_code','') IN ('no_answer','timeout'))::int AS no_answer_total,
      COUNT(*) FILTER (WHERE l.status IN ('cancelled','recycled') AND l.dial_started AND COALESCE(l.metadata->>'blending_deferred','false')<>'true')::int AS hangups_total,
      COUNT(*) FILTER (WHERE l.status = 'suppressed')::int AS suppressed_total,
      COUNT(*) FILTER (WHERE l.status = 'skipped')::int AS skipped_total,
      COUNT(DISTINCT l.contact_record_id) FILTER (
        WHERE COALESCE(l.metadata->>'blending_deferred','false')<>'true'
          AND (
            l.status IN ('completed','failed','suppressed','skipped')
            OR (l.status IN ('cancelled','recycled') AND l.dial_started)
          )
      )::int AS processed_records,
      COUNT(*) FILTER (WHERE (l.status = 'answered' OR NULLIF(l.metadata->>'answered_at','') IS NOT NULL OR EXISTS (SELECT 1 FROM acd_work_items w JOIN acd_legs leg ON leg.work_item_id=w.id AND leg.role='customer' WHERE w.outbound_attempt_id=l.id::text AND leg.answered_at IS NOT NULL)) AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS answered_last_30m,
      COUNT(*) FILTER (WHERE l.status = 'failed' AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS failed_last_30m,
      COUNT(*) FILTER (WHERE l.status = 'suppressed' AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS suppressed_last_30m,
      MAX(l.created_at) FILTER (WHERE l.dial_started AND COALESCE(l.metadata->>'blending_deferred','false')<>'true') AS last_attempt_at,
      COUNT(*) FILTER (WHERE l.message_state IN ('pending','rendered','queued','sending'))::int AS messages_queued,
      COUNT(*) FILTER (WHERE l.message_state IN ('accepted','sent'))::int AS messages_in_flight,
      COUNT(*) FILTER (WHERE l.message_state IN ('accepted','sent','delivered','read','replied','unconfirmed'))::int AS messages_sent,
      COUNT(*) FILTER (WHERE l.message_state IN ('delivered','read','replied'))::int AS messages_delivered,
      COUNT(*) FILTER (WHERE l.message_state = 'read')::int AS messages_read,
      COUNT(*) FILTER (WHERE l.message_state = 'replied')::int AS messages_replied,
      COUNT(*) FILTER (WHERE l.message_state IN ('failed_permanent','undeliverable','failed_transient'))::int AS messages_failed,
      COUNT(*) FILTER (WHERE l.message_state = 'unconfirmed')::int AS messages_unconfirmed,
      COUNT(*) FILTER (WHERE l.message_state = 'throttled')::int AS messages_throttled,
      COUNT(*) FILTER (WHERE l.message_state = 'suppressed' AND COALESCE(l.metadata->>'reason_code','') = 'opted_out')::int AS messages_opted_out
    FROM attempts l
    GROUP BY l.campaign_id`;
