import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureAgentState, setAgentPresence } from "./agent-state.mjs";
import { appendEvent } from "./events.mjs";

export async function ensureVoiceEndpointSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_voice_endpoints (
      id UUID PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES users(id),
      auth_session_id TEXT NOT NULL, device_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('web','ios')), label TEXT NOT NULL,
      secret_hash TEXT NOT NULL, credential_id TEXT, sip_username TEXT,
      ready BOOLEAN NOT NULL DEFAULT false, push_ready BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, auth_session_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS cc_agent_voice_preferences (
      agent_id TEXT PRIMARY KEY REFERENCES users(id), endpoint_id UUID REFERENCES cc_voice_endpoints(id),
      generation BIGINT NOT NULL DEFAULT 0
    );
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS video_ready BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS media_endpoint_id UUID;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS wrapup_endpoint_id UUID;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS wrapup_owner_version BIGINT NOT NULL DEFAULT 0;
  `);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const voiceLockKey = (agentId) => `cc-voice-owner:${agentId}`;

async function transaction(pool, agentId, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // HTTP commands use the same advisory lock. Capacity/routing use the row lock below.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [voiceLockKey(agentId)]);
    await ensureAgentState(db, agentId);
    const state = (await db.query("SELECT * FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [agentId])).rows[0];
    const result = await fn(db, state);
    await db.query("COMMIT");
    return result;
  } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  finally { db.release(); }
}

export async function readVoiceEndpoints(db, agentId) {
  const preference = (await db.query("SELECT endpoint_id, generation FROM cc_agent_voice_preferences WHERE agent_id=$1", [agentId])).rows[0];
  const endpoints = (await db.query(`SELECT id, kind, label, ready, push_ready,
      expires_at > now() AND (ready OR push_ready) AS reachable
    FROM cc_voice_endpoints WHERE agent_id=$1 AND revoked_at IS NULL ORDER BY created_at`, [agentId])).rows;
  const handoffs=(await db.query(`SELECT id,work_item_id,data->>'targetId' AS target_id,data->>'channel' AS channel
    FROM acd_sagas WHERE type='device_handoff' AND state='running' AND step='await_video'
      AND data->>'agentId'=$1 ORDER BY created_at DESC LIMIT 1`,[agentId])).rows;
  return { handoffs, endpointId: preference?.endpoint_id || null, generation: String(preference?.generation || 0), endpoints };
}

// Called while holding the same agent row/advisory locks as voice routing.
// Messaging reservations and their workflow must not own the phone device.
async function hasVoiceWork(db, agentId, state) {
  const occupied = (await db.query(`SELECT 1 FROM acd_reservations
    WHERE agent_id=$1 AND channel IN ('voice','video') AND state<>'released' LIMIT 1`, [agentId])).rowCount;
  if (occupied) return true;
  if (state.workflow_state === 'idle') return false;
  if (!state.workflow_work_item_id) return true; // Unknown legacy ownership fails closed.
  const work = (await db.query('SELECT channel FROM acd_work_items WHERE id=$1', [state.workflow_work_item_id])).rows[0];
  return !work || ['voice','video'].includes(work.channel);
}

async function registerVoiceEndpointUnderLock(pool, user, body, provision) {
  if (!user.authSessionId) throw fail(409, "Sign in again to register this device.");
  if (!['web','ios'].includes(body.kind) || !body.deviceId || String(body.deviceId).length > 128) throw fail(400, "Invalid device registration");
  // Check legacy enrollment before creating a remote credential. A blocked UI
  // may retry, and each refusal must not leave an unused Telnyx credential.
  // Recheck under the commit lock below in case new work arrives meanwhile.
  await transaction(pool, String(user.id), async (db, state) => {
    const managed = (await db.query('SELECT 1 FROM cc_agent_voice_preferences WHERE agent_id=$1', [String(user.id)])).rowCount;
    if (!managed && await hasVoiceWork(db, String(user.id), state)) throw fail(409, 'Finish the voice/video interaction and wrap-up before enabling device selection.');
  });
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  // Provision outside the database transaction. The stable endpoint is reused on reconnect.
  const existing = (await pool.query(`SELECT * FROM cc_voice_endpoints WHERE agent_id=$1 AND auth_session_id=$2 AND device_id=$3`,
    [String(user.id), user.authSessionId, body.deviceId])).rows[0];
  const credential = existing?.credential_id ? { id: existing.credential_id, username: existing.sip_username } : await provision(id);
  if (!credential?.id || !credential.username) throw fail(503, "Could not provision this device's voice identity.");
  return transaction(pool, String(user.id), async (db,state) => {
    const managed=(await db.query('SELECT 1 FROM cc_agent_voice_preferences WHERE agent_id=$1',[String(user.id)])).rowCount;
    if (!managed && await hasVoiceWork(db, String(user.id), state)) throw fail(409,'Finish the voice/video interaction and wrap-up before enabling device selection.');
    const endpoint = (await db.query(`INSERT INTO cc_voice_endpoints(id,agent_id,auth_session_id,device_id,kind,label,secret_hash,credential_id,sip_username)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(agent_id,auth_session_id,device_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,
        label=EXCLUDED.label, revoked_at=NULL, ready=false, push_ready=false, expires_at=now()
      RETURNING *`, [id,String(user.id),user.authSessionId,body.deviceId,body.kind,String(body.label || (body.kind === 'ios' ? 'Phone' : 'Computer')).slice(0,80),hash(secret),credential.id,credential.username])).rows[0];
    // Selection is always explicit, including the first device. No last-login-wins behavior.
    const enrolled = await db.query(`INSERT INTO cc_agent_voice_preferences(agent_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING agent_id`, [String(user.id)]);
    if (enrolled.rowCount) await db.query(`UPDATE acd_agent_sessions SET capabilities=jsonb_set(jsonb_set(capabilities,'{voice}','false'),'{video}','false') WHERE agent_id=$1`, [String(user.id)]);
    return { ...await readVoiceEndpoints(db,String(user.id)), registration: { id: endpoint.id, token: `${endpoint.id}.${secret}` } };
  });
}

export async function authenticateVoiceEndpoint(db, user, token) {
  const [id, secret] = String(token || '').split('.');
  if (!/^[0-9a-f-]{36}$/i.test(id || '') || !secret) throw fail(409, "Register this voice device first.");
  const endpoint = (await db.query(`SELECT * FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND auth_session_id=$3 AND revoked_at IS NULL`,
    [id,String(user.id),user.authSessionId || ''])).rows[0];
  if (!endpoint || !timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(endpoint.secret_hash))) throw fail(403, "This voice device session is no longer valid.");
  return endpoint;
}

export async function chooseVoiceEndpoint(pool, user, { endpointId, expectedGeneration }) {
  return transaction(pool,String(user.id),async (db,state) => {
    const current = await readVoiceEndpoints(db,String(user.id));
    if (String(expectedGeneration) !== current.generation) throw fail(409,"The voice device changed. Refresh before selecting again.");
    if (current.endpointId === endpointId) return current;
    // Even a temporarily disconnected call retains workflow/reservation ownership.
    if (await hasVoiceWork(db, String(user.id), state)) throw fail(409,"Finish the voice/video interaction and wrap-up before switching devices.");
    const target = (await db.query(`SELECT * FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL
      AND expires_at>now() AND (ready OR push_ready)`,[endpointId,String(user.id)])).rows[0];
    if (!target?.credential_id) throw fail(409,"The selected device is not ready. Open the app and reconnect it first.");
    await db.query(`UPDATE cc_agent_voice_preferences SET endpoint_id=$2,generation=generation+1 WHERE agent_id=$1`,[String(user.id),endpointId]);
    // Existing routing paths read this canonical destination. Each endpoint's own credential stays separate.
    await db.query(`UPDATE users SET telephony_credentials_id=$2,telephony_user_name=$3 WHERE id=$1`,[String(user.id),target.credential_id,target.sip_username]);
    await db.query(`UPDATE acd_agent_sessions SET capabilities=jsonb_set(jsonb_set(capabilities,'{voice}',to_jsonb(id=$2::uuid)),'{video}',
      to_jsonb(id=$2::uuid AND $3::boolean)),
      state=CASE WHEN id=$2::uuid THEN 'online' ELSE state END WHERE agent_id=$1`,[String(user.id),endpointId,target.video_ready]);
    await setAgentPresence(db,String(user.id),'online',{actor:'voice_selection',reason:'device_selected'});
    await appendEvent(db,{agentId:String(user.id),type:'voice_endpoint_changed',actor:`agent:${user.id}`,payload:{endpoint_id:endpointId,generation:String(BigInt(current.generation)+1n)}});
    return readVoiceEndpoints(db,String(user.id));
  });
}

// Run all HTTP voice mutations under this lock so an idle handoff cannot race
// an outbound reservation or a delayed command from the previous device.
export async function withVoiceControl(pool, user, request, callback) {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[voiceLockKey(user.id)]); locked=true;
    const preference=(await db.query("SELECT * FROM cc_agent_voice_preferences WHERE agent_id=$1",[String(user.id)])).rows[0];
    if (preference) {
      const endpoint=await authenticateVoiceEndpoint(db,user,request.headers.get('x-cc-endpoint-token'));
      if (endpoint.id !== preference.endpoint_id || String(preference.generation) !== request.headers.get('x-cc-voice-generation')) throw fail(409,"This interaction is controlled on the selected voice device. Refresh to see its current owner.");
    }
    return await callback();
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[voiceLockKey(user.id)]);
    db.release();
  }
}

export async function revokeVoiceEndpoint(pool,user,token) {
  return transaction(pool,String(user.id),async (db,state) => {
    const endpoint=await authenticateVoiceEndpoint(db,user,token);
    const preference=(await db.query("SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1",[String(user.id)])).rows[0];
    if (preference?.endpoint_id === endpoint.id && state.workflow_state !== 'idle') throw fail(409,"Finish the current interaction before signing out of its voice device.");
    await db.query("UPDATE cc_voice_endpoints SET revoked_at=now(),ready=false,push_ready=false,expires_at=now() WHERE id=$1",[endpoint.id]);
    await db.query("UPDATE acd_agent_sessions SET state='offline',capabilities='{}'::jsonb,expires_at=now() WHERE id=$1",[endpoint.id]);
    return { ok:true };
  });
}

export async function revokeAuthVoiceEndpoints(pool,user,sessionId) {
  if (!sessionId) return;
  return transaction(pool,String(user.id),async (db,state) => {
    const owned=(await db.query(`SELECT e.id FROM cc_voice_endpoints e JOIN cc_agent_voice_preferences p ON p.endpoint_id=e.id
      WHERE e.agent_id=$1 AND e.auth_session_id=$2`,[String(user.id),sessionId])).rows[0];
    if (owned && state.workflow_state!=='idle') throw fail(409,'Finish the current interaction before signing out of its voice device.');
    await db.query(`UPDATE acd_agent_sessions SET state='offline',capabilities='{}'::jsonb,expires_at=now()
      WHERE id IN (SELECT id FROM cc_voice_endpoints WHERE agent_id=$1 AND auth_session_id=$2)`,[String(user.id),sessionId]);
    await db.query(`UPDATE cc_voice_endpoints SET revoked_at=now(),ready=false,push_ready=false,expires_at=now() WHERE agent_id=$1 AND auth_session_id=$2`,[String(user.id),sessionId]);
    await db.query('DELETE FROM cc_mobile_devices WHERE user_id=$1 AND auth_session_id=$2',[String(user.id),sessionId]);
  });
}

export async function renewVoiceEndpoint(pool,user,endpoint,provision) {
  return transaction(pool,String(user.id),async (db,state) => {
    const current=(await db.query('SELECT * FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL',[endpoint.id,String(user.id)])).rows[0];
    if (!current) throw fail(409,'Voice endpoint is no longer active');
    if (current.credential_id!==endpoint.credential_id) return current;
    if (state.workflow_state!=='idle') throw fail(409,'Voice identity renewal waits until the current interaction ends.');
    const credential=await provision(current.id);
    if (!credential?.id || !credential.username) throw fail(503,'Could not renew the voice identity');
    await db.query('UPDATE cc_voice_endpoints SET credential_id=$2,sip_username=$3,ready=false,push_ready=false,expires_at=now() WHERE id=$1',[current.id,credential.id,credential.username]);
    await db.query(`UPDATE users u SET telephony_credentials_id=$2,telephony_user_name=$3
      FROM cc_agent_voice_preferences p WHERE u.id=$1 AND p.agent_id=u.id AND p.endpoint_id=$4`,[String(user.id),credential.id,credential.username,current.id]);
    await db.query("UPDATE acd_agent_sessions SET capabilities=jsonb_set(jsonb_set(capabilities,'{voice}','false'),'{video}','false') WHERE id=$1",[current.id]);
    return {...current,credential_id:credential.id,sip_username:credential.username};
  });
}


export async function registerVoiceEndpoint(pool,user,body,provision) {
  const db=await pool.connect();
  const key=`cc-voice-registration:${user.id}:${user.authSessionId}:${String(body.deviceId).slice(0,128)}`;
  let locked=false;
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);locked=true;
    return await registerVoiceEndpointUnderLock(pool,user,body,provision);
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
    db.release();
  }
}
