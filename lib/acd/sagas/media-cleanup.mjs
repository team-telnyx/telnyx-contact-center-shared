import { defineSaga, startSaga } from '../saga-engine.mjs';
import { appendEvent } from '../events.mjs';

export async function startTerminalMediaCleanup(tx, workItemId) {
  const live = await tx.query(`SELECT 1 FROM acd_legs WHERE work_item_id = $1 AND ended_at IS NULL LIMIT 1`, [workItemId]);
  if (!live.rowCount) return;
  const owner = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id = $1 AND type = 'media_cleanup' AND state IN ('running','compensating')`, [workItemId]);
  if (!owner.rowCount) await startSaga(tx, { type: 'media_cleanup', workItemId, conflictKey: 'media-cleanup' });
}

defineSaga('media_cleanup', { initialStep: 'verify', steps: {
  verify: { run: async (tx, ctx) => {
    // A completed external transfer still has a live media owner. That owner
    // decides when its customer/target topology may be torn down.
    const owner = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id = $1 AND id <> $2 AND state IN ('running','compensating')`, [ctx.workItem.id, ctx.saga.id]);
    if (owner.rowCount) return null;
    const leg = (await tx.query(`SELECT * FROM acd_legs WHERE work_item_id = $1 AND ended_at IS NULL ORDER BY created_at LIMIT 1`, [ctx.workItem.id])).rows[0];
    if (!leg) return 'succeeded';
    await tx.query(`UPDATE acd_sagas SET data = data || jsonb_build_object('legId', $2::text, 'callId', $3::text) WHERE id = $1`, [ctx.saga.id, leg.id, leg.provider_call_id]);
    return 'hangup';
  }, deadlineMs: 60000 },
  hangup: { cmd: ctx => ({ operation: 'terminal_media_hangup', targetLegId: ctx.data.legId,
    endpoint: `/calls/${encodeURIComponent(ctx.data.callId)}/actions/hangup`, request: {} }),
    on: { accepted: 'await_end', 'leg.ended': 'verify' }, deadlineMs: 10000, onDeadline: 'await_end', onFailure: 'await_end' },
  await_end: { run: async (tx, ctx) => {
    const leg = (await tx.query(`SELECT ended_at FROM acd_legs WHERE id = $1`, [ctx.data.legId])).rows[0];
    return leg?.ended_at ? 'verify' : null;
  }, on: { 'leg.ended': 'verify' }, deadlineMs: 60000, onDeadline: 'alarm' },
  alarm: { run: async (tx, ctx) => {
    if (!ctx.data.alarmed) {
      await appendEvent(tx, { workItemId: ctx.workItem.id, type: 'manual_intervention_required', actor: 'saga:media_cleanup', payload: { saga_id: ctx.saga.id, reason: 'terminal_media_end_unconfirmed' } });
      await tx.query(`UPDATE acd_sagas SET data = data || '{"alarmed":true}'::jsonb WHERE id = $1`, [ctx.saga.id]);
    }
    return 'await_end';
  } },
} });
