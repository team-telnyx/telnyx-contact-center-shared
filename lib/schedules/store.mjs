import { randomUUID } from "node:crypto";
import { getPostgresPool } from "../postgres.mjs";
import { normalizeResource, normalizeNodeConfig, ScheduleError } from "./evaluator.mjs";

const conflict = () => { throw new ScheduleError("This resource changed. Reload before saving or publishing.", "version_conflict", 409); };
export function createScheduleStore(db) {
  if (!db) throw new ScheduleError("Schedule database unavailable.", "database_unavailable", 503);
  const transaction = async run => {
    const client = await db.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  async function get(id, client = db, lock = false) {
    const r = await client.query(`SELECT * FROM cc_schedule_resources WHERE id=$1 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!r.rows[0]) throw new ScheduleError("Schedule resource not found.", "not_found", 404);
    return r.rows[0];
  }
  async function references(id, client = db) {
    const result = await client.query(`SELECT DISTINCT f.id, f.name FROM voice_flows f, jsonb_array_elements(f.nodes) n
      WHERE n->'data'->>'nodeType'='schedules' AND
      ((n->'data'->'config'->>'source'='shared' AND n->'data'->'config'->>'scheduleId'=$1)
        OR (n->'data'->'config'->>'useExceptions'='true' AND COALESCE(n->'data'->'config'->'calendarIds','[]'::jsonb) ? $1)) ORDER BY f.name`, [id]);
    return result.rows;
  }
  return {
    get, references,
    async list({ drafts = false } = {}) {
      const r = await db.query(`SELECT r.*, v.document AS published, v.published_at FROM cc_schedule_resources r
        LEFT JOIN cc_schedule_revisions v ON v.resource_id=r.id AND v.revision=r.published_revision
        WHERE r.archived_at IS NULL ${drafts ? "" : "AND r.published_revision>0"} ORDER BY r.draft->>'name', r.id`);
      return r.rows.map(row => drafts ? row : { id: row.id, kind: row.kind, published_revision: row.published_revision, published: row.published, published_at: row.published_at });
    },
    async create(input, actor) {
      const draft = normalizeResource(input), id = randomUUID();
      return (await db.query(`INSERT INTO cc_schedule_resources(id,kind,draft,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *`, [id, draft.kind, JSON.stringify(draft), actor])).rows[0];
    },
    async save(id, input, editVersion, actor) {
      const draft = normalizeResource(input);
      return transaction(async client => {
        const old = await get(id, client, true); if (old.edit_version !== editVersion) conflict();
        if (old.kind !== draft.kind) throw new ScheduleError("The resource type cannot be changed.");
        return (await client.query(`UPDATE cc_schedule_resources SET draft=$2,edit_version=edit_version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, JSON.stringify(draft), actor])).rows[0];
      });
    },
    async publish(id, editVersion, actor) {
      return transaction(async client => {
        const row = await get(id, client, true); if (row.edit_version !== editVersion) conflict();
        const draft = normalizeResource(row.draft), revision = row.published_revision + 1;
        const published = (await client.query(`INSERT INTO cc_schedule_revisions(resource_id,revision,document,published_by) VALUES($1,$2,$3,$4) RETURNING *`, [id, revision, JSON.stringify(draft), actor])).rows[0];
        await client.query(`UPDATE cc_schedule_resources SET published_revision=$2,edit_version=edit_version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1`, [id, revision, actor]);
        return { ...published, affectedFlows: await references(id, client) };
      });
    },
    async archive(id, editVersion, actor) {
      return transaction(async client => {
        const old = await get(id, client, true); if (old.edit_version !== editVersion) conflict();
        const affected = await references(id, client);
        if (affected.length) throw new ScheduleError("Remove this resource from its Call Flows before archiving.", "resource_in_use", 409, { affectedFlows: affected });
        await client.query(`UPDATE cc_schedule_resources SET archived_at=clock_timestamp(),updated_by=$2,edit_version=edit_version+1 WHERE id=$1`, [id, actor]);
        return { archived: true };
      });
    },
    async revisions(ids, asOf = new Date().toISOString()) {
      if (!ids.length) return [];
      const rows = (await db.query(`SELECT DISTINCT ON (resource_id) resource_id AS id,revision,document,published_at
        FROM cc_schedule_revisions WHERE resource_id=ANY($1::text[]) AND published_at <= $2::timestamptz
        ORDER BY resource_id, published_at DESC, revision DESC`, [ids, asOf])).rows;
      return ids.map(id => { const row = rows.find(r => r.id === id); if (!row) throw new ScheduleError(`No published revision is available for resource ${id}.`, "resource_unpublished"); return { id, revision: row.revision, ...row.document }; });
    },
    async validateFlow(nodes) {
      for (const node of nodes || []) if (node.data?.nodeType === "schedules") {
        const config = normalizeNodeConfig(node.data.config);
        const ids = [...(config.source === "shared" ? [config.scheduleId] : []), ...(config.useExceptions ? config.calendarIds : [])];
        const resources = await this.revisions(ids);
        for (const r of resources) {
          await get(r.id);
          if (r.kind !== (r.id === config.scheduleId && config.source === "shared" ? "schedule" : "calendar")) throw new ScheduleError("A schedule or calendar reference has the wrong type.");
        }
      }
    },
    async executionContext({ flowId, callControlId, receivedAt, snapshotAt, nodes = [] }) {
      const configs = Object.fromEntries(nodes.filter(n => n.data?.nodeType === "schedules").map(n => [n.id, n.data.config]));
      await db.query(`INSERT INTO cc_schedule_contexts(flow_id,call_control_id,snapshot_at,received_at,node_configs)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [flowId, callControlId, snapshotAt, receivedAt, JSON.stringify(configs)]);
      return (await db.query(`SELECT * FROM cc_schedule_contexts WHERE flow_id=$1 AND call_control_id=$2`, [flowId, callControlId])).rows[0];
    },
    async context(flowId, callControlId) { return (await db.query("SELECT * FROM cc_schedule_contexts WHERE flow_id=$1 AND call_control_id=$2", [flowId, callControlId])).rows[0] || null; },
    async evaluation(flowId, callControlId, nodeId, visitKey, result) {
      const keys = [flowId, callControlId, nodeId, visitKey];
      if (result) await db.query(`INSERT INTO cc_schedule_evaluations(flow_id,call_control_id,node_id,visit_key,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...keys, JSON.stringify(result)]);
      return (await db.query(`SELECT result FROM cc_schedule_evaluations WHERE flow_id=$1 AND call_control_id=$2 AND node_id=$3 AND visit_key=$4`, keys)).rows[0]?.result;
    },
  };
}
export const scheduleStore = () => createScheduleStore(getPostgresPool());
