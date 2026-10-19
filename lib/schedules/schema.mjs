export async function ensureSchedulesSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_schedule_resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('schedule','calendar')),
      draft JSONB NOT NULL, edit_version INTEGER NOT NULL DEFAULT 1,
      published_revision INTEGER NOT NULL DEFAULT 0,
      archived_at TIMESTAMPTZ, created_by TEXT, updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_schedule_revisions (
      resource_id TEXT NOT NULL REFERENCES cc_schedule_resources(id), revision INTEGER NOT NULL,
      document JSONB NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), published_by TEXT,
      PRIMARY KEY(resource_id, revision)
    );
    CREATE INDEX IF NOT EXISTS cc_schedule_revisions_time ON cc_schedule_revisions(resource_id, published_at DESC);
    CREATE TABLE IF NOT EXISTS cc_schedule_contexts (
      flow_id TEXT NOT NULL, call_control_id TEXT NOT NULL,
      snapshot_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
      node_configs JSONB NOT NULL DEFAULT '{}', PRIMARY KEY(flow_id, call_control_id)
    );
    CREATE INDEX IF NOT EXISTS cc_schedule_contexts_time ON cc_schedule_contexts(snapshot_at);
    CREATE TABLE IF NOT EXISTS cc_schedule_evaluations (
      flow_id TEXT NOT NULL, call_control_id TEXT NOT NULL, node_id TEXT NOT NULL, visit_key TEXT NOT NULL,
      result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(flow_id, call_control_id, node_id, visit_key),
      FOREIGN KEY(flow_id, call_control_id) REFERENCES cc_schedule_contexts(flow_id, call_control_id) ON DELETE CASCADE
    );
  `);
}
