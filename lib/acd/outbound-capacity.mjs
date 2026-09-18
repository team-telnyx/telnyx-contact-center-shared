// Agent capacity is shared with inbound. Provider line capacity is shared by
// ALL campaigns; claims never expire after a command might have been sent.
export async function reserveOutboundLine(tx, { attemptId, campaignId, workItemId, sagaId, campaign }) {
  await tx.query(`SELECT pg_advisory_xact_lock(741901, 5)`);
  const previous = (await tx.query(`SELECT * FROM acd_outbound_lines WHERE attempt_id = $1`, [attemptId])).rows[0];
  if (previous) return previous.released_at ? false : true;
  const settings = (await tx.query(`SELECT settings FROM outbound_settings WHERE id = 'default'`)).rows[0]?.settings || {};
  const finiteLimit = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.floor(Number(value)) : fallback;
  const globalLimit = finiteLimit(settings.max_lines ?? settings.maxLines, 10);
  const config = campaign.concurrency_config || {};
  const campaignLimit = finiteLimit(config.maxLines ?? config.maxConcurrent, globalLimit);
  const usage = (await tx.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE campaign_id = $1)::int AS campaign FROM (
    SELECT campaign_id FROM acd_outbound_lines WHERE released_at IS NULL
    UNION ALL SELECT l.campaign_id::text FROM outbound_attempt_ledger l WHERE l.status IN ('dialing', 'answered')
      AND NOT EXISTS (SELECT 1 FROM acd_outbound_lines a WHERE a.attempt_id = l.id::text)
    ) live`, [campaignId])).rows[0];
  if (usage.total >= globalLimit || usage.campaign >= campaignLimit) return false;
  await tx.query(`INSERT INTO acd_outbound_lines (attempt_id, campaign_id, work_item_id, owner_saga_id) VALUES ($1, $2, $3, $4)`, [attemptId, campaignId, workItemId, sagaId]);
  return true;
}

export async function releaseOutboundLine(tx, attemptId, reason) {
  if (!reason) throw new Error("Outbound line release requires evidence");
  await tx.query(`UPDATE acd_outbound_lines SET released_at = now(), release_reason = $2 WHERE attempt_id = $1 AND released_at IS NULL`, [attemptId, reason]);
  await finalizeTimedOutOutboundAttempt(tx, attemptId);
}

export async function finalizeTimedOutOutboundAttempt(tx, attemptId = null) {
  return (await tx.query(
    `UPDATE outbound_attempt_ledger ledger
        SET status = 'completed',
            dial_state = 'disposed',
            next_retry_at = NULL,
            lease_expires_at = NULL,
            metadata = COALESCE(ledger.metadata, '{}'::jsonb) || jsonb_build_object(
              'disposition_code_id', 'auto_timeout',
              'disposition_classification', 'none',
              'business_category', 'none',
              'reason_code', 'wrapup_timeout',
              'retry_eligible', false,
              'requires_callback', false,
              'disposition_recorded_at', now(),
              'disposition_source', 'reconciler'
            ),
            updated_at = now()
      WHERE ($1::text IS NULL OR ledger.id::text = $1)
        -- A connected call is already 'completed' when its customer leg ends:
        -- the origination saga releases the line and settles the ledger long
        -- before the agent wrap-up deadline expires. Keying only on in-flight
        -- statuses made this finalization unreachable on the normal path.
        -- The wrap-up evidence below is the real gate; an existing
        -- disposition_code_id keeps a dispositioned attempt untouched.
        AND (
          ledger.status IN ('claimed', 'dialing', 'answered')
          OR (
            ledger.status = 'completed'
            AND COALESCE(ledger.metadata->>'disposition_code_id', '') = ''
          )
        )
        -- The untargeted backstop sweep runs on every reconciler tick, so it
        -- must not scan the whole historical ledger. A wrap-up deadline always
        -- expires within minutes of its call.
        AND ($1::text IS NOT NULL OR ledger.updated_at > now() - interval '6 hours')
        AND NOT EXISTS (
          SELECT 1 FROM acd_outbound_lines line
           WHERE line.attempt_id = ledger.id::text AND line.released_at IS NULL
        )
        AND EXISTS (
          SELECT 1
            FROM acd_work_items work
            JOIN LATERAL (
              SELECT segment.id, segment.wrapup_code_id, segment.wrapup_ended_at
                FROM acd_segments segment
               WHERE segment.work_item_id = work.id AND segment.kind = 'agent'
               ORDER BY segment.seq DESC
               LIMIT 1
            ) final_segment ON true
           WHERE work.outbound_attempt_id = ledger.id::text
             AND work.terminal_at IS NOT NULL
             AND work.state IN ('completed', 'abandoned', 'failed')
             AND final_segment.wrapup_ended_at IS NOT NULL
             AND (
               final_segment.wrapup_code_id = 'auto_timeout'
               OR EXISTS (
                 SELECT 1 FROM acd_events event
                  WHERE event.work_item_id = work.id
                    AND event.type = 'wrapup_completed'
                    AND event.payload->>'reason' = 'auto_timeout'
                    AND event.payload->>'segment_id' = final_segment.id::text
               )
             )
        )`,
    [attemptId],
  )).rowCount;
}
