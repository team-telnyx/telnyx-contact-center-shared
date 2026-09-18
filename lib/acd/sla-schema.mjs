export async function ensureSlaSchema(db) {
  await db.query(`ALTER TABLE cc_queues ADD COLUMN IF NOT EXISTS sla_policies JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE cc_queues ALTER COLUMN sla_policies SET DEFAULT '{"voice":{"mode":"inherit"}}'::jsonb;
    ALTER TABLE cc_queues ADD COLUMN IF NOT EXISTS sla_revision BIGINT NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS acd_sla_measurements (
      id UUID PRIMARY KEY,work_item_id UUID NOT NULL REFERENCES acd_work_items(id) ON DELETE CASCADE,
      segment_id UUID REFERENCES acd_segments(id) ON DELETE CASCADE,scope_key TEXT NOT NULL,channel TEXT NOT NULL,queue_id TEXT,
      policy JSONB NOT NULL,started_at TIMESTAMPTZ NOT NULL,deadline_at TIMESTAMPTZ,served_at TIMESTAMPTZ,
      service_evidence_id TEXT,service_agent_id TEXT,excluded_reason TEXT,UNIQUE(work_item_id,scope_key));
    CREATE INDEX IF NOT EXISTS acd_sla_range ON acd_sla_measurements(started_at,channel,queue_id);
    CREATE INDEX IF NOT EXISTS acd_sla_pending ON acd_sla_measurements(deadline_at) WHERE served_at IS NULL;
    CREATE INDEX IF NOT EXISTS acd_messages_work_page ON acd_messages(work_item_id,seq);
    CREATE TABLE IF NOT EXISTS cc_sla_policy_audit (
      id UUID PRIMARY KEY,queue_id TEXT,revision BIGINT NOT NULL,policies JSONB NOT NULL,actor TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE OR REPLACE VIEW acd_sla_status AS SELECT m.*,COALESCE(s.ended_at,w.terminal_at) AS ended_at,
      CASE WHEN m.excluded_reason IS NOT NULL THEN 'excluded'
        WHEN m.policy->>'status'<>'configured' THEN m.policy->>'status'
        WHEN m.served_at IS NOT NULL THEN CASE WHEN m.served_at<=m.deadline_at THEN 'met' ELSE 'breached' END
        WHEN COALESCE(s.ended_at,w.terminal_at,now())>=m.deadline_at THEN 'breached'
        WHEN COALESCE(s.ended_at,w.terminal_at) IS NOT NULL THEN 'unserved' ELSE 'pending' END AS state,
      (m.excluded_reason IS NULL AND m.policy->>'status'='configured' AND m.served_at IS NULL AND COALESCE(s.ended_at,w.terminal_at) IS NULL AND now()<m.deadline_at
        AND now()>=m.started_at+make_interval(secs=>COALESCE((m.policy->>'thresholdSeconds')::double precision,0)*COALESCE((m.policy->>'warningPercentage')::double precision,80)/100)) AS at_risk
      FROM acd_sla_measurements m JOIN acd_work_items w ON w.id=m.work_item_id LEFT JOIN acd_segments s ON s.id=m.segment_id;`);
}
