import { createHash, randomUUID } from 'node:crypto';
import { buildTelnyxV2Url } from '../telnyx.js';
import { originateGeneratedCall, parseGeneratorClientState, buildGeneratorClientState, handleGeneratorWebhookEvent, hangupGeneratedCall } from './engine.mjs';
import { loadGeneratorSettings, effectiveRunLimits, rampedConcurrency, startRunLoop } from './runner.mjs';
import { correlateRunCalls } from './correlation.mjs';
import { scheduleGeneratorActions, driveGeneratorCommands, completeGeneratorCommand } from './commands.mjs';

const OPEN_MEDIA = `dial_requested_at IS NOT NULL AND media_ended_at IS NULL AND COALESCE(result->>'dial_rejected','false') <> 'true'`;
const EXECUTOR_LOCK = 71429308;

export async function persistGeneratorWebhook(db, event) {
  if (!event.eventId || !event.eventType || !event.payload?.call_control_id) throw new Error('Malformed generator event');
  const hash = createHash('sha256').update(JSON.stringify([event.eventType,event.payload])).digest('hex');
  await db.query(`INSERT INTO cg_webhook_inbox(event_id,event_type,payload,payload_hash,occurred_at)
    VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
  [event.eventId,event.eventType,JSON.stringify(event.payload),hash,event.occurredAt || null]);
  const saved = (await db.query('SELECT payload_hash FROM cg_webhook_inbox WHERE event_id=$1', [event.eventId])).rows[0];
  if (saved?.payload_hash !== hash) throw new Error('Webhook event ID payload conflict');
}

export function canBindGeneratorLeg(row, eventType, payload, state) {
  if (!row || !payload.call_control_id) return false;
  if (state?.ledgerId && (String(state.ledgerId) !== String(row.id) || (state.runId && String(state.runId) !== String(row.run_id)))) return false;
  if (row.call_control_id) return row.call_control_id === payload.call_control_id;
  // The same marker can be echoed by the called flow. It is correlation data,
  // not permission to bind an inbound CC/agent leg as the generator's own leg.
  return eventType === 'call.initiated' && payload.direction === 'outgoing' && Boolean(row.dial_requested_at)
    && payload.from === row.from_number && payload.to === row.to_number && String(state?.ledgerId) === String(row.id);
}

export async function ownsGeneratorEvent(db,event) {
  const state=parseGeneratorClientState(event.payload?.client_state);
  const rows=(await db.query('SELECT * FROM cg_call_ledger WHERE id::text=$1 OR call_control_id=$2',[state?.ledgerId||null,event.payload?.call_control_id])).rows;
  return rows.length===1&&canBindGeneratorLeg(rows[0],event.eventType,event.payload,state);
}

export async function drainGeneratorInbox(db) {
  const events = (await db.query(`SELECT * FROM cg_webhook_inbox WHERE processed_at IS NULL AND next_attempt_at <= now()
    ORDER BY received_at,event_id LIMIT 100`)).rows;
  for (const event of events) {
    await db.query('BEGIN');
    try {
      const payload = event.payload;
      const state = parseGeneratorClientState(payload.client_state);
      const candidates = (await db.query(`SELECT * FROM cg_call_ledger WHERE id::text=$1 OR call_control_id=$2`,
        [state?.ledgerId || null,payload.call_control_id])).rows;
      const row = candidates.length === 1 ? candidates[0] : null;
      if (!canBindGeneratorLeg(row,event.event_type,payload,state)) {
        await db.query(`UPDATE cg_webhook_inbox SET attempts=attempts+1,next_attempt_at=now()+interval '2 seconds',
          processed_at=CASE WHEN received_at < now()-interval '5 minutes' THEN now() END,
          outcome=CASE WHEN received_at < now()-interval '5 minutes' THEN 'unowned' END WHERE event_id=$1`, [event.event_id]);
      } else {
        await db.query(`UPDATE cg_call_ledger SET call_control_id=COALESCE(call_control_id,$2),call_session_id=COALESCE(call_session_id,$3),
          status=CASE WHEN result->>'dial_rejected'='true' AND media_ended_at IS NULL THEN 'dialing' ELSE status END,
          ended_at=CASE WHEN result->>'dial_rejected'='true' AND media_ended_at IS NULL THEN NULL ELSE ended_at END,
          result=CASE WHEN result->>'dial_rejected'='true' THEN (result-'dial_rejected')||'{"provider_response_conflict":true}'::jsonb ELSE result END
          WHERE id=$1`, [row.id,payload.call_control_id,payload.call_session_id || null]);
        await handleGeneratorWebhookEvent(db,event.event_type,{...payload,client_state:buildGeneratorClientState({runId:row.run_id,ledgerId:row.id})});
        await completeGeneratorCommand(db,row.id,event.event_type,payload,{eventId:event.event_id,occurredAt:event.occurred_at});
        if (event.event_type === 'call.recording.saved') {
          await db.query(`UPDATE cg_call_ledger SET result=COALESCE(result,'{}'::jsonb) ||
            jsonb_build_object('recording', $2::jsonb) WHERE id=$1`, [row.id,JSON.stringify({
            id:payload.recording_id,urls:payload.recording_urls || payload.public_recording_urls,
            started_at:payload.recording_started_at,ended_at:payload.recording_ended_at,event_id:event.event_id,
          })]);
        }
        if (event.event_type === 'call.recording.error') await db.query(`UPDATE cg_call_ledger SET result=COALESCE(result,'{}'::jsonb) || '{"recording_error":true}'::jsonb WHERE id=$1`,[row.id]);
        await db.query(`UPDATE cg_webhook_inbox SET processed_at=now(),outcome='applied',attempts=attempts+1 WHERE event_id=$1`, [event.event_id]);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      await db.query(`UPDATE cg_webhook_inbox SET attempts=attempts+1,next_attempt_at=now()+interval '5 seconds',last_error=$2 WHERE event_id=$1`, [event.event_id, String(error.message).slice(0,300)]);
    }
  }
  return events.length;
}

// One executor holds a PG session lock, so global CPS and concurrency include
// every run and every process. A crash releases the lock but not a claimed call.
export async function claimGeneratorDial(db, settings) {
  if (settings.enabled !== true) return null;
  const global = effectiveRunLimits(settings);
  const usage = (await db.query(`SELECT count(*) FILTER (WHERE ${OPEN_MEDIA})::int AS active,
    count(*) FILTER (WHERE dial_requested_at > now()-interval '1 second')::int AS recent,
    count(*) FILTER (WHERE (result->>'telnyx_status') IN ('401','403','422','429') AND dial_requested_at > now()-interval '30 seconds')::int AS failures
    FROM cg_call_ledger`)).rows[0];
  if (usage.active >= global.maxConcurrent || usage.recent >= global.maxCps || usage.failures >= 5) return null;
  const runs = (await db.query(`SELECT * FROM cg_runs WHERE status='running' ORDER BY started_at,id`)).rows;
  for (const run of runs) {
    const limits = effectiveRunLimits(settings,run.config || {},run.config?.scenario_snapshot || {});
    const usage = (await db.query(`SELECT count(*) FILTER (WHERE ${OPEN_MEDIA})::int AS active,
      count(*) FILTER (WHERE dial_requested_at>now()-interval '1 second')::int AS recent FROM cg_call_ledger WHERE run_id=$1`, [run.id])).rows[0];
    if (usage.recent >= limits.maxCps || usage.active >= rampedConcurrency(limits.maxConcurrent,limits.rampUpSecs,Date.now()-Date.parse(run.started_at))) continue;
    const row = (await db.query(`UPDATE cg_call_ledger SET status='dialing',dial_requested_at=now(),started_at=COALESCE(started_at,now()),
      deadline_at=now()+($2::int*interval '1 second')
      WHERE id=(SELECT l.id FROM cg_call_ledger l JOIN cg_runs r ON r.id=l.run_id
        WHERE l.run_id=$1 AND r.status='running' AND l.status='pending' AND l.dial_requested_at IS NULL
        ORDER BY l.created_at,l.id LIMIT 1 FOR UPDATE OF l,r SKIP LOCKED) RETURNING *`,
    [run.id,limits.dialTimeoutSecs+limits.maxDurationSecs+15])).rows[0];
    if (!row) continue;
    return { row, run:{...run,config:{...run.config,dialTimeoutSecs:limits.dialTimeoutSecs,
      postAnswer:{...run.config?.postAnswer,maxDurationSecs:limits.maxDurationSecs},pstnWhitelist:settings.pstn_whitelist || []}} };
  }
  return null;
}

export async function reapGeneratorMedia(db, { fetchImpl=fetch }={}) {
  await db.query(`UPDATE cg_call_ledger l SET status='failed',ended_at=COALESCE(ended_at,now()),
    result=COALESCE(l.result,'{}'::jsonb)||'{"reason":"cancelled_before_dial"}'::jsonb
    FROM cg_runs r WHERE r.id=l.run_id AND l.status='pending' AND l.dial_requested_at IS NULL
      AND (r.status<>'running' OR NOT EXISTS(SELECT 1 FROM cg_settings WHERE id='default' AND settings->>'enabled'='true'))`);
  const rows=(await db.query(`SELECT l.*,r.status AS run_status FROM cg_call_ledger l JOIN cg_runs r ON r.id=l.run_id
    WHERE l.dial_requested_at IS NOT NULL AND l.media_ended_at IS NULL AND COALESCE(l.result->>'dial_rejected','false')<>'true'
      AND (l.deadline_at < now() OR r.status<>'running' OR l.result->>'stop_requested'='true'
        OR NOT EXISTS(SELECT 1 FROM cg_settings WHERE id='default' AND settings->>'enabled'='true'))
      AND (l.result->>'last_cleanup_at' IS NULL OR (l.result->>'last_cleanup_at')::timestamptz < now()-interval '10 seconds')
    ORDER BY l.deadline_at LIMIT 10`)).rows;
  for (const row of rows) {
    await db.query(`UPDATE cg_call_ledger SET result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('stop_requested',true,'last_cleanup_at',now()) WHERE id=$1`,[row.id]);
    if (!row.call_control_id) {
      await db.query(`UPDATE cg_call_ledger SET result=result||'{"origination_unknown":true,"cleanup_unresolved":true}'::jsonb WHERE id=$1`,[row.id]);
      continue; // There is no safe target to hang up or originate again.
    }
    await hangupGeneratedCall(row.call_control_id);
    try {
      const response=await fetchImpl(buildTelnyxV2Url(`/calls/${encodeURIComponent(row.call_control_id)}`),{
        signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`}});
      if (response.ok && (await response.json())?.data?.is_alive === false) {
        await db.query(`UPDATE cg_call_ledger SET media_ended_at=now(),ended_at=COALESCE(ended_at,now()),
          status=CASE WHEN status IN ('dialing','ringing','answered','talking') THEN 'completed' ELSE status END,
          result=result||'{"media_end_evidence":"provider_is_alive_false"}'::jsonb WHERE id=$1`,[row.id]);
      }
    } catch { /* Missing evidence remains open and visible in preflight/report. */ }
  }
  return rows.length;
}

export async function generatorTick(pool,{node=`generator-${process.pid}`,originate=originateGeneratedCall,fetchImpl=fetch}={}) {
  const db=await pool.connect();
  let locked=false;
  try {
    locked=(await db.query('SELECT pg_try_advisory_lock($1) AS locked',[EXECUTOR_LOCK])).rows[0].locked;
    if (!locked) return {busy:true};
    await db.query(`UPDATE cg_runtime_state SET heartbeat_at=now(),node_id=$1 WHERE id='executor'`,[node]);
    for (const pending of (await db.query("SELECT id FROM cg_runs WHERE status='pending' ORDER BY created_at LIMIT 10")).rows) {
      const result=await startRunLoop(pool,pending.id);
      if(!result.ok)await db.query("UPDATE cg_runs SET status='failed',stopped_at=now(),stats=stats||jsonb_build_object('error',$2::text) WHERE id=$1 AND status='pending'",[pending.id,result.reason]);
    }
    const events=await drainGeneratorInbox(db);
    await reapGeneratorMedia(db,{fetchImpl});
    const runs=(await db.query(`SELECT DISTINCT run_id FROM cg_call_ledger WHERE dial_requested_at IS NOT NULL
      AND (media_ended_at IS NULL OR (work_item_id IS NULL AND dial_requested_at > now()-interval '10 minutes'))
      AND COALESCE(result->>'dial_rejected','false') <> 'true' LIMIT 100`)).rows;
    for (const {run_id} of runs) {
      await correlateRunCalls(db,run_id);
      const calls=(await db.query(`SELECT id FROM cg_call_ledger WHERE run_id=$1 AND answered_at IS NOT NULL AND media_ended_at IS NULL`,[run_id])).rows;
      for (const call of calls) await scheduleGeneratorActions(db,call.id);
    }
    await driveGeneratorCommands(db,{fetchImpl});
    const settings=await loadGeneratorSettings(db);
    let dialed=0;
    for(let i=0;i<effectiveRunLimits(settings).maxCps;i++) {
      const claim=await claimGeneratorDial(db,settings);
      if(!claim) break;
      await originate(db,{run:claim.run,ledgerRow:claim.row,fromNumber:claim.row.from_number,
        task:{target_type:claim.row.result.target_type || 'call_flow',target:claim.row.result.target || claim.row.result.flow_id,
          direct_agent_id:claim.row.result.direct_agent_id || null}});
      dialed++;
    }
    await db.query(`UPDATE cg_runs r SET status='completed',stopped_at=now() WHERE r.status='running'
      AND EXISTS(SELECT 1 FROM cg_call_ledger WHERE run_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM cg_call_ledger WHERE run_id=r.id AND (status='pending' OR (${OPEN_MEDIA})))`);
    return {events,dialed};
  } finally {
    if(locked) await db.query('SELECT pg_advisory_unlock($1)',[EXECUTOR_LOCK]).catch(()=>{});
    db.release();
  }
}

export function startGeneratorWorker(pool,{onError=()=>{},intervalMs=500,...options}={}) {
  let stopped=false,timer;
  const node=options.node || `generator-${process.pid}-${randomUUID()}`;
  const tick=async()=>{
    if(stopped) return;
    try{await generatorTick(pool,{...options,node});}catch(error){onError(error);}
    if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}
  };
  void tick();
  return {stop(){stopped=true;clearTimeout(timer);}};
}
