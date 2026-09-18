import { buildTelnyxV2Url } from '../telnyx.js';
import { agentBridgeEvidence, loadVoiceBridgeTopology } from '../acd/voice-bridge-evidence.mjs';

export function generatorCommand(step) {
  switch (step.type) {
    case 'speak': return { action: 'speak', body: { payload: step.text, voice: step.voice || 'AWS.Polly.Joanna' }, wait: 'call.speak.ended' };
    case 'play_media': return { action: 'playback_start', body: { media_name: step.media_name, ...(step.loop === 'infinity' ? { loop: 'infinity' } : {}) }, wait: step.loop === 'infinity' ? 'call.playback.started' : 'call.playback.ended' };
    case 'play_audio': return { action: 'playback_start', body: { audio_url: step.audio_url, loop: step.loop === 'infinity' ? 'infinity' : 1 }, wait: step.loop === 'infinity' ? 'call.playback.started' : 'call.playback.ended' };
    case 'send_dtmf': return { action: 'send_dtmf', body: { digits: step.digits }, wait: 'call.dtmf.sent' };
    case 'delay': return { action: 'delay', body: { delay_ms: Math.min(30000, Math.max(0, Number(step.delay_ms) || 0)) }, wait: null };
    case 'record': return { action: 'record_start', body: { format: 'wav', channels: 'single', recording_track: 'inbound', play_beep: false }, wait: null };
    default: throw new Error(`Unsupported generator action: ${step.type}`);
  }
}

export async function scheduleGeneratorActions(db, ledgerId) {
  const row = (await db.query(`SELECT l.*, r.config FROM cg_call_ledger l JOIN cg_runs r ON r.id = l.run_id WHERE l.id = $1`, [ledgerId])).rows[0];
  if (!row?.answered_at || row.media_ended_at || !row.call_control_id) return false;
  if (row.result?.action_trigger === 'agent_bridge') {
    const segments = (await db.query(`SELECT agent_id FROM acd_segments WHERE work_item_id=$1
      AND kind='agent' AND answered_at IS NOT NULL AND ended_at IS NULL`, [row.work_item_id])).rows;
    const topology = segments.length ? await loadVoiceBridgeTopology(db, row.work_item_id) : { legs: [], intents: [] };
    const bridged = segments.some(s => agentBridgeEvidence(topology.legs, topology.intents, s.agent_id, { live: true }));
    if (!bridged) return false;
  }
  if(row.result?.action_trigger==='agent_bridge')await db.query("UPDATE cg_call_ledger SET status='talking' WHERE id=$1 AND status='answered'",[ledgerId]);
  let steps = row.result?.action_steps;
  if (!Array.isArray(steps)) {
    const config = row.config?.postAnswer || {};
    steps = config.action === 'silence' ? [] : config.action === 'audio_loop' && config.audioUrl
      ? [{ type: 'play_audio', audio_url: config.audioUrl, loop: 'infinity' }]
      : [{ type: 'speak', text: config.ttsText || 'This is an automated test call.', voice: 'AWS.Polly.Joanna' }];
  }
  for (const [sequence, step] of steps.entries()) {
    const command = generatorCommand(step);
    await db.query(`INSERT INTO cg_commands(id,ledger_id,sequence,action,body,wait_event)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (ledger_id,sequence) DO NOTHING`,
    [`cg-${ledgerId}-${sequence}`, ledgerId, sequence, command.action, JSON.stringify(command.body), command.wait]);
  }
  return true;
}

// Called under the executor's database session lock. Persist the command ID
// before sending. Unknown responses reuse this ID and never advance the sequence.
export async function driveGeneratorCommands(db, { fetchImpl = fetch } = {}) {
  await db.query(`UPDATE cg_commands c SET status = 'cancelled', completed_at = now()
    FROM cg_call_ledger l WHERE l.id = c.ledger_id AND l.media_ended_at IS NOT NULL AND c.completed_at IS NULL`);
  const commands = (await db.query(`SELECT c.*, l.call_control_id, l.run_id, l.deadline_at AS call_deadline
    FROM cg_commands c JOIN cg_call_ledger l ON l.id = c.ledger_id
    WHERE c.completed_at IS NULL AND c.status <> 'failed' AND c.due_at <= now() AND l.media_ended_at IS NULL
      AND COALESCE(l.result->>'stop_requested','false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM cg_commands previous WHERE previous.ledger_id = c.ledger_id
        AND previous.sequence < c.sequence AND previous.status <> 'completed')
    ORDER BY c.due_at,c.id LIMIT 20`)).rows;
  for (const c of commands) {
    if (c.deadline_at && Date.parse(c.deadline_at) < Date.now()) {
      await db.query(`UPDATE cg_commands SET status = 'failed', last_error = 'command_evidence_timeout' WHERE id=$1 AND completed_at IS NULL`, [c.id]);
      continue;
    }
    if (c.action === 'delay') {
      if (c.status === 'pending') await db.query(`UPDATE cg_commands SET status = 'waiting', due_at = now() + ($2::int * interval '1 millisecond'), requested_at = now() WHERE id=$1`, [c.id, c.body.delay_ms]);
      else await db.query(`UPDATE cg_commands SET status = 'completed', completed_at=now() WHERE id=$1`, [c.id]);
      continue;
    }
    if (c.status === 'waiting') continue; // Only the matching ended event can release the barrier.
    if (!c.call_control_id) continue;
    await db.query(`UPDATE cg_commands SET status='sending', attempts=attempts+1,
      requested_at=COALESCE(requested_at,now()), deadline_at=COALESCE(deadline_at,now()+interval '90 seconds'),
      due_at=now()+interval '10 seconds' WHERE id=$1 AND completed_at IS NULL`, [c.id]);
    const clientState = Buffer.from(JSON.stringify({ callGenerator: true, runId: c.run_id, ledgerId: c.ledger_id, generatorCommandId: c.id })).toString('base64');
    try {
      const response = await fetchImpl(buildTelnyxV2Url(`/calls/${encodeURIComponent(c.call_control_id)}/actions/${c.action}`), {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...c.body, command_id: c.id, client_state: clientState }),
      });
      if (!response.ok) {
        const definitive = response.status >= 400 && response.status < 500 && ![408,429].includes(response.status);
        await db.query(`UPDATE cg_commands SET status=$2,last_error=$3 WHERE id=$1 AND completed_at IS NULL`, [c.id, definitive ? 'failed' : 'unknown', `provider_http_${response.status}`]);
      } else await db.query(`UPDATE cg_commands SET acknowledged_at=COALESCE(acknowledged_at,now()),
        status=CASE WHEN completed_at IS NULL AND status NOT IN ('failed','cancelled') THEN $2 ELSE status END,
        completed_at=CASE WHEN completed_at IS NULL AND status NOT IN ('failed','cancelled') AND $2='completed' THEN now() ELSE completed_at END
        WHERE id=$1`, [c.id, c.wait_event ? 'waiting' : 'completed']);
    } catch {
      await db.query(`UPDATE cg_commands SET status='unknown',last_error='provider_response_unknown' WHERE id=$1 AND completed_at IS NULL`, [c.id]);
    }
  }
  return commands.length;
}

export async function completeGeneratorCommand(db, ledgerId, eventType, payload, event = {}) {
  let state;
  try { state = JSON.parse(Buffer.from(payload.client_state || '', 'base64').toString()); } catch { state={}; }
  const id = payload.command_id || state.generatorCommandId;
  if (!id) return;
  // An accepted HTTP request is not proof of execution. Preserve a correlated
  // asynchronous failure even after the sequence barrier has been released.
  if(['failed','error'].includes(payload.status)) {
    await db.query(`UPDATE cg_commands SET status='failed',last_error='provider_action_failed',
      completed_at=COALESCE(completed_at,now()),last_event_id=$4,last_event_type=$3,
      provider_status_detail=$5
      WHERE id=$1 AND ledger_id=$2 AND requested_at IS NOT NULL AND status NOT IN ('failed','cancelled')
        AND (wait_event=$3 OR (action='playback_start' AND $3='call.playback.ended')
          OR (action='record_start' AND $3='call.recording.error'))`,
    [id,ledgerId,eventType,event.eventId||null,String(payload.status_detail||payload.failure_reason||'provider_action_failed').slice(0,2000)]);
    return;
  }
  if(eventType==='call.playback.started') {
    await db.query(`UPDATE cg_commands SET playback_started_at=COALESCE(playback_started_at,$3::timestamptz,now()),
      last_event_id=$4,last_event_type=$5
      WHERE id=$1 AND ledger_id=$2 AND action='playback_start' AND requested_at IS NOT NULL
        AND playback_started_at IS NULL AND status NOT IN ('failed','cancelled')`,
    [id,ledgerId,event.occurredAt||null,event.eventId||null,eventType]);
  }
  await db.query(`UPDATE cg_commands SET status='completed',completed_at=now(),last_error=NULL
    WHERE id=$1 AND ledger_id=$2 AND wait_event=$3 AND requested_at IS NOT NULL AND completed_at IS NULL
      AND status NOT IN ('failed','cancelled') AND ($3<>'call.playback.ended' OR $4='completed')`, [id, ledgerId, eventType,payload.status||null]);
}
