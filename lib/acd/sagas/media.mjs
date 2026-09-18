import { randomUUID, createHash } from "node:crypto";
import { defineSaga, startSaga, driveSaga } from "../saga-engine.mjs";

export const mediaSaga = defineSaga("media", {
  initialStep: "send",
  steps: {
    send: {
      cmd: ctx => ({
        operation: ctx.data.action,
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/${ctx.data.action}`,
        request: ctx.data.action === "speak"
          ? { payload: ctx.data.text, voice: "Telnyx.NaturalHD.astra", stop: "all" }
          : {},
      }),
      on: { accepted: "succeeded" },
      deadlineMs: 10000,
    },
  },
});

export async function requestMediaIntent(pool, { interactionId, agentId, action, text, provider, requestId = randomUUID() }) {
  const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
  if (!pool) fail("ACD database unavailable", 503);
  if (!["speak", "stop_speak"].includes(action)) fail("Unsupported media intent", 400);
  if (action === "speak" && (typeof text !== "string" || !text.trim() || text.length > 5000)) {
    fail("Text must contain 1–5000 characters", 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) fail("Invalid media request id", 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ interactionId, action, text })).digest('hex');
  const db = await pool.connect();
  let sagaId;
  try {
    await db.query("BEGIN");
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const prior = (await db.query(`SELECT * FROM acd_action_requests WHERE request_id = $1`, [requestId])).rows[0];
    if (prior) {
      if (prior.agent_id !== agentId || prior.fingerprint !== fingerprint) fail("Request id already used", 409);
      await db.query("COMMIT"); return { sagaId: prior.saga_id, accepted: true };
    }
    const result = await db.query(
      `SELECT w.* FROM acd_work_items w
        WHERE w.id::text = $1 FOR UPDATE`,
      [interactionId],
    );
    const item = result.rows[0];
    if (!item) fail("Work item not found", 404);
    if (item.channel !== "voice" || item.state !== "active") fail("Call is not active", 409);
    const owner = await db.query(
      `SELECT 1 FROM acd_segments WHERE work_item_id = $1 AND agent_id = $2
        AND kind = 'agent' AND ended_at IS NULL`, [item.id, agentId],
    );
    if (!owner.rows.length) fail("Call belongs to another agent", 403);
    const conflict = await db.query(
      `SELECT 1 FROM acd_sagas WHERE work_item_id = $1
        AND conflict_key = 'call-control' AND state IN ('running', 'compensating')`, [item.id],
    );
    if (conflict.rows.length) fail("Call transfer or consultation is in progress", 409);
    const leg = (await db.query(
      `SELECT provider_call_id FROM acd_legs WHERE work_item_id = $1 AND role = 'customer'
        AND state <> 'ended' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [item.id],
    )).rows[0];
    if (!leg?.provider_call_id) fail("Customer leg unavailable", 409);
    ({ sagaId } = await startSaga(db, {
      type: "media", workItemId: item.id, conflictKey: "call-control",
      data: { action, text, customerProviderCallId: leg.provider_call_id },
      actor: `agent:${agentId}`,
    }));
    await db.query(`INSERT INTO acd_action_requests (request_id, agent_id, work_item_id, action, fingerprint, saga_id) VALUES ($1,$2,$3,$4,$5,$6)`, [requestId, agentId, item.id, action, fingerprint, sagaId]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    if (error.code === "ACD_SAGA_CONFLICT") error.status = 409;
    throw error;
  } finally {
    db.release();
  }
  if (provider) await driveSaga(pool, sagaId, { provider });
  return { sagaId, accepted: true };
}
