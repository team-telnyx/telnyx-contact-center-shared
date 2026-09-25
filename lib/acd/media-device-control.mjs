import { authenticateVoiceEndpoint } from "./voice-endpoints.mjs";
import { appendEvent } from "./events.mjs";

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const token = request => request.headers.get('x-cc-endpoint-token');

async function context(db, user, request, { workItemId, segmentId = null, wrapup = false }) {
  const segment = (await db.query(`SELECT s.*,w.channel,w.terminal_at,
      EXISTS(SELECT 1 FROM acd_outbound_lines l WHERE l.attempt_id=w.outbound_attempt_id AND l.released_at IS NULL) AS live_outbound,
      EXISTS(SELECT 1 FROM acd_text_assignments a WHERE a.segment_id=s.id AND a.state<>'wrapup') AS non_wrapup_assignment
    FROM acd_segments s
    JOIN acd_work_items w ON w.id=s.work_item_id WHERE s.work_item_id=$1 AND s.agent_id=$2 AND s.kind='agent'
      AND ($3::text IS NULL OR s.id::text=$3)
    ORDER BY s.seq DESC LIMIT 1`, [workItemId,String(user.id),segmentId])).rows[0];
  const preference = (await db.query('SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1',[String(user.id)])).rows[0];
  const channel = segment?.channel || (await db.query('SELECT channel FROM acd_work_items WHERE id=$1',[workItemId])).rows[0]?.channel;
  if (!['voice','video'].includes(channel)) return { canControl:true, managed:false, channel };
  // Unenrolled legacy agents retain their previous workflow. Enrolled agents
  // with no recorded segment owner must explicitly take over, never guess.
  if (!preference) return { canControl:true, managed:false, channel };
  const endpoint = token(request) ? await authenticateVoiceEndpoint(db,user,token(request)) : null;
  // An agent can receive a new offer after a previous handling segment. A
  // past segment must not choose the device for that new offer.
  const ownerId = segment && (wrapup || !segment.ended_at)
    ? (wrapup ? segment.wrapup_endpoint_id : segment.media_endpoint_id) : preference.endpoint_id;
  const owner = ownerId ? (await db.query('SELECT label,kind FROM cc_voice_endpoints WHERE id=$1',[ownerId])).rows[0] : null;
  const pending = Boolean(segment?.ended_at && !segment.wrapup_ended_at &&
    ['completed','failed','transferred'].includes(segment.outcome) && !segment.live_outbound && !segment.non_wrapup_assignment);
  return { managed:true,channel,segmentId:segment?.id || null,endpointId:ownerId || null,
    label:owner?.kind==='ios'?'iPhone':owner?.label || (ownerId?'Other device':'Unassigned device'),
    canControl:Boolean(endpoint && ownerId===endpoint.id),
    canTakeOver:Boolean(wrapup && pending && endpoint && ownerId!==endpoint.id),
    version:String(segment?.wrapup_owner_version || 0), endpoint, segment };
}
export async function mediaDevicePresentation(db,user,request,options) {
  const {endpoint,segment,...presentation}=await context(db,user,request,options);
  return presentation;
}

// The session advisory lock spans callbacks that use their own transactions.
// Save/end/takeover all share it; changing ownership cannot race a stale write.
export async function withWrapupDevice(pool,user,request,options,callback) {
  const db=await pool.connect();const key=`cc-wrapup-device:${options.workItemId}:${user.id}`;
  let locked=false;
  try {
    const lock=await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key]);
    locked=lock.rows[0].acquired;
    if (!locked) throw fail('Another device operation is in progress. Retry shortly.');
    const state=await context(db,user,request,{...options,wrapup:true});
    if (state.managed && String(options.ownerVersion)!==state.version) throw fail('Wrap-up ownership changed. Refresh and retry.');
    if (!state.canControl) throw fail(`Wrap-up is handled on ${state.label}. Take over wrap-up first.`);
    return await callback();
  } finally {try {if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{db.release();}}
}

export async function takeOverWrapup(pool,user,request,{workItemId,segmentId,expectedVersion}) {
  const db=await pool.connect();const key=`cc-wrapup-device:${workItemId}:${user.id}`;
  try {
    await db.query('BEGIN');
    const lock=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key]);
    if (!lock.rows[0].acquired) throw fail('Wrap-up is being updated. Retry shortly.');
    const state=await context(db,user,request,{workItemId,segmentId,wrapup:true});
    if (!state.managed || !state.endpoint || !state.segment || !state.canTakeOver) throw fail('Wrap-up is no longer available for takeover');
    if (String(expectedVersion)!==state.version) throw fail('Wrap-up ownership changed. Refresh and retry.');
    // Do not allow a takeover before the caller/agent handling segment ends.
    const updated=await db.query(`UPDATE acd_segments SET wrapup_endpoint_id=$2,wrapup_owner_version=wrapup_owner_version+1
      WHERE id=$1 AND agent_id=$3 AND ended_at IS NOT NULL AND wrapup_ended_at IS NULL RETURNING id`,
      [state.segment.id,state.endpoint.id,String(user.id)]);
    if (!updated.rowCount) throw fail('Wrap-up has already completed');
    await appendEvent(db,{workItemId,agentId:String(user.id),actor:`agent:${user.id}`,type:'wrapup_device_changed',
      payload:{segment_id:state.segment.id,endpoint_id:state.endpoint.id,previous_endpoint_id:state.endpointId}});
    await db.query('COMMIT');
    return {ok:true};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}

export async function withVideoDevice(pool,user,request,workItemId,callback) {
  const db=await pool.connect();const key=`cc-voice-owner:${user.id}`;
  let locked=false;
  try {
    const lock=await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key]);
    locked=lock.rows[0].acquired;
    if (!locked) throw fail('Another device operation is in progress. Retry shortly.');
    const switching=await db.query(`SELECT 1 FROM acd_sagas WHERE work_item_id=$1 AND type='device_handoff'
      AND state IN ('running','compensating') AND step IN ('kick_video_source','await_video_departure','commit_video')`,[workItemId]);
    if(switching.rowCount)throw fail('The video session is switching devices.');
    const state=await context(db,user,request,{workItemId});
    if (!state.canControl) throw fail(`Video is handled on ${state.label}.`);
    return await callback();
  }finally{try {if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}finally{db.release();}}
}
