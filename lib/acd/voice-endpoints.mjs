import { voiceReachableSql, videoReachableSql } from "./push-readiness.mjs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureAgentState, setAgentPresence } from "./agent-state.mjs";
import { appendEvent } from "./events.mjs";

export async function ensureVoiceEndpointSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_voice_endpoints (
      id UUID PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES users(id),
      auth_session_id TEXT NOT NULL, device_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('web','ios','android')), label TEXT NOT NULL,
      secret_hash TEXT NOT NULL, credential_id TEXT, sip_username TEXT,
      ready BOOLEAN NOT NULL DEFAULT false, push_ready BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, auth_session_id, device_id)
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cc_voice_endpoints'::regclass
        AND conname='cc_voice_endpoints_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%android%') THEN
        ALTER TABLE cc_voice_endpoints DROP CONSTRAINT cc_voice_endpoints_kind_check;
        ALTER TABLE cc_voice_endpoints ADD CONSTRAINT cc_voice_endpoints_kind_check CHECK (kind IN ('web','ios','android'));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS cc_agent_voice_preferences (
      agent_id TEXT PRIMARY KEY REFERENCES users(id), endpoint_id UUID REFERENCES cc_voice_endpoints(id),
      generation BIGINT NOT NULL DEFAULT 0
    );
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS socket_ready_until TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS push_token_hash TEXT;
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS video_ready BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS video_ready_until TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS form_factor TEXT CHECK (form_factor IN ('phone','tablet'));
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS media_endpoint_id UUID;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS wrapup_endpoint_id UUID;
    ALTER TABLE acd_segments ADD COLUMN IF NOT EXISTS wrapup_owner_version BIGINT NOT NULL DEFAULT 0;
  `);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const voiceLockKey = (agentId) => `cc-voice-owner:${agentId}`;
// A device's default name when the app sends none: the platform's phone, or
// its tablet when the registration says so. The user's own name wins.
export const defaultEndpointLabel = (kind, formFactor) =>
  kind === 'android' ? (formFactor === 'tablet' ? 'Android tablet' : 'Android')
  : kind === 'ios' ? (formFactor === 'tablet' ? 'iPad' : 'iPhone') : 'Computer';
export const endpointLabel = (endpoint) => endpoint?.label || defaultEndpointLabel(endpoint?.kind, endpoint?.form_factor);

// A registration nobody can route to any more. Stale: its lease ran out a day ago and
// neither the socket nor push can reach it (it re-registers the moment the app opens).
// Superseded: a newer registration of the same installation exists — the old login of
// one phone, not a second phone. The computer is one device, so its browsers only
// supersede each other by kind. Hidden from the pickers and the handoff; on the profile a
// phone stays listed (and forgettable) until the sweep, browsers are the one computer.
export const staleEndpointSql = (e = 'e') => `(NOT ${voiceReachableSql(e)} AND ${e}.expires_at < now() - interval '24 hours')`;
export const supersededEndpointSql = (e = 'e') => `EXISTS (SELECT 1 FROM cc_voice_endpoints newer
  WHERE newer.agent_id=${e}.agent_id AND newer.kind=${e}.kind AND newer.revoked_at IS NULL AND newer.created_at>${e}.created_at
    AND (${e}.kind='web' OR newer.device_id=${e}.device_id)
    AND (${voiceReachableSql('newer')} OR NOT ${voiceReachableSql(e)}))`;
export const liveEndpointSql = (e = 'e') => `(NOT ${staleEndpointSql(e)} AND NOT ${supersededEndpointSql(e)})`;

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
  // The selected endpoint stays listed however stale, so the picker can say it is unavailable.
  const endpoints = (await db.query(`SELECT e.id, e.device_id AS "deviceId", e.kind, e.form_factor AS "formFactor", e.label, e.ready, e.push_ready,
      ${voiceReachableSql('e')} AS reachable,
      CASE WHEN NOT ${voiceReachableSql('e')} THEN 'unavailable'
        WHEN e.ready AND e.socket_ready_until>now() THEN 'connected' ELSE 'standby' END AS availability
    FROM cc_voice_endpoints e WHERE e.agent_id=$1 AND e.revoked_at IS NULL AND (e.id=$2 OR ${liveEndpointSql('e')}) ORDER BY e.created_at`,
    [agentId, preference?.endpoint_id || null])).rows;
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
  if (!['web','ios','android'].includes(body.kind) || !body.deviceId || String(body.deviceId).length > 128) throw fail(400, "Invalid device registration");
  // Web has no form factor; a phone or tablet says which so the pickers can draw it.
  const formFactor = body.kind === 'web' ? null : ['phone','tablet'].includes(body.formFactor) ? body.formFactor : null;
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
  const reused = Boolean(existing?.credential_id);
  const credential = reused ? { id: existing.credential_id, username: existing.sip_username } : await provision(id);
  if (!credential?.id || !credential.username) throw fail(503, "Could not provision this device's voice identity.");
  return transaction(pool, String(user.id), async (db,state) => {
    const managed=(await db.query('SELECT 1 FROM cc_agent_voice_preferences WHERE agent_id=$1',[String(user.id)])).rowCount;
    if (!managed && await hasVoiceWork(db, String(user.id), state)) throw fail(409,'Finish the voice/video interaction and wrap-up before enabling device selection.');
    // The credential read above may be stale by now: a renewal that replaced it wins (the upsert keeps the
    // row's own), and a sweep that released it leaves the row without one, so this registration starts over.
    if (reused) {
      const current=(await db.query('SELECT credential_id FROM cc_voice_endpoints WHERE agent_id=$1 AND auth_session_id=$2 AND device_id=$3 FOR UPDATE',[String(user.id),user.authSessionId,body.deviceId])).rows[0];
      if (!current?.credential_id) throw fail(409,"This device's voice identity was released. Register it again.");
    }
    const endpoint = (await db.query(`INSERT INTO cc_voice_endpoints(id,agent_id,auth_session_id,device_id,kind,form_factor,label,secret_hash,credential_id,sip_username,last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT(agent_id,auth_session_id,device_id) DO UPDATE SET secret_hash=EXCLUDED.secret_hash,
        credential_id=COALESCE(cc_voice_endpoints.credential_id,EXCLUDED.credential_id), sip_username=COALESCE(cc_voice_endpoints.sip_username,EXCLUDED.sip_username),
        label=EXCLUDED.label, form_factor=EXCLUDED.form_factor, revoked_at=NULL, ready=false, push_ready=false, expires_at=now(), last_seen_at=now()
      RETURNING *`, [id,String(user.id),user.authSessionId,body.deviceId,body.kind,formFactor,String(body.label || defaultEndpointLabel(body.kind, formFactor)).slice(0,80),hash(secret),credential.id,credential.username])).rows[0];
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
  // The code lets a browser tab whose connection was retired register again instead of reading "not permitted".
  if (!endpoint || !timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(endpoint.secret_hash))) throw Object.assign(fail(403, "This voice device session is no longer valid."), { code: 'VOICE_ENDPOINT_REVOKED' });
  return endpoint;
}

// Point the agent's calls at `target`: the selection and its generation, the canonical
// routing identity the existing paths read, and which session carries voice and video.
async function applyVoiceSelection(db, agentId, target, { generation, actor, reason = null }) {
  await db.query(`UPDATE cc_agent_voice_preferences SET endpoint_id=$2,generation=generation+1 WHERE agent_id=$1`,[agentId,target.id]);
  // Existing routing paths read this canonical destination. Each endpoint's own credential stays separate.
  await db.query(`UPDATE users SET telephony_credentials_id=$2,telephony_user_name=$3 WHERE id=$1`,[agentId,target.credential_id,target.sip_username]);
  await db.query(`UPDATE acd_agent_sessions SET capabilities=jsonb_set(jsonb_set(capabilities,'{voice}',to_jsonb(id=$2::uuid)),'{video}',
    to_jsonb(id=$2::uuid AND $3::boolean)),
    state=CASE WHEN id=$2::uuid THEN 'online' ELSE state END WHERE agent_id=$1`,[agentId,target.id,target.video_reachable]);
  await setAgentPresence(db,agentId,'online',{actor:'voice_selection',reason:reason || 'device_selected'});
  await appendEvent(db,{agentId,type:'voice_endpoint_changed',actor,
    payload:{endpoint_id:target.id,generation:String(BigInt(generation)+1n),...(reason ? {reason} : {})}});
}

export async function chooseVoiceEndpoint(pool, user, { endpointId, expectedGeneration }) {
  return transaction(pool,String(user.id),async (db,state) => {
    const current = await readVoiceEndpoints(db,String(user.id));
    if (String(expectedGeneration) !== current.generation) throw fail(409,"The voice device changed. Refresh before selecting again.");
    if (current.endpointId === endpointId) return current;
    // Even a temporarily disconnected call retains workflow/reservation ownership.
    if (await hasVoiceWork(db, String(user.id), state)) throw fail(409,"Finish the voice/video interaction and wrap-up before switching devices.");
    const target = (await db.query(`SELECT *,${videoReachableSql("e")} AS video_reachable FROM cc_voice_endpoints e WHERE id=$1 AND agent_id=$2 AND ${voiceReachableSql('e')}`,[endpointId,String(user.id)])).rows[0];
    if (!target?.credential_id) throw fail(409,"The selected device is not ready. Open the app and reconnect it first.");
    await applyVoiceSelection(db,String(user.id),target,{generation:current.generation,actor:`agent:${user.id}`});
    return readVoiceEndpoints(db,String(user.id));
  });
}

// The computer is one device, however many browsers and tabs connect it. When it takes the
// calls and the tab holding them is gone (closed, signed out, asleep), the calls move to a
// connected tab of the computer, the most recently seen. Only within the computer: a phone
// is chosen explicitly, nothing is chosen for an agent who never chose, and voice work in
// progress keeps its tab. Called after a browser heartbeat; returns the new endpoint or null.
export async function followComputerSelection(pool, agentId) {
  const liveTab = (e, selected) => `${e}.agent_id=$1 AND ${e}.kind='web' AND ${e}.id<>${selected} AND ${e}.credential_id IS NOT NULL AND ${voiceReachableSql(e)}`;
  // Unlocked first: nearly every heartbeat finds the selection where it belongs.
  const candidate = await pool.query(`SELECT 1 FROM cc_agent_voice_preferences p JOIN cc_voice_endpoints s ON s.id=p.endpoint_id
    WHERE p.agent_id=$1 AND s.kind='web' AND NOT ${voiceReachableSql('s')}
      AND EXISTS (SELECT 1 FROM cc_voice_endpoints e WHERE ${liveTab('e','s.id')})`,[agentId]);
  if (!candidate.rowCount) return null;
  return transaction(pool, agentId, async (db, state) => {
    const current = (await db.query(`SELECT p.endpoint_id, p.generation, s.kind, ${voiceReachableSql('s')} AS reachable
      FROM cc_agent_voice_preferences p JOIN cc_voice_endpoints s ON s.id=p.endpoint_id WHERE p.agent_id=$1`,[agentId])).rows[0];
    if (!current || current.kind !== 'web' || current.reachable || await hasVoiceWork(db, agentId, state)) return null;
    const target = (await db.query(`SELECT e.*, ${videoReachableSql('e')} AS video_reachable FROM cc_voice_endpoints e
      WHERE ${liveTab('e','$2')} ORDER BY e.last_seen_at DESC NULLS LAST, e.created_at DESC LIMIT 1`,[agentId,current.endpoint_id])).rows[0];
    if (!target) return null;
    await applyVoiceSelection(db,agentId,target,{generation:current.generation,actor:'voice_selection:computer',reason:'computer_tab_changed'});
    return target.id;
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

const AVAILABILITY_RANK = { unavailable: 0, standby: 1, connected: 2 };
const latest = (rows) => rows.reduce((at, row) => !at || (row.lastSeenAt && new Date(row.lastSeenAt) > new Date(at)) ? row.lastSeenAt : at, null);
const best = (rows) => rows.reduce((top, row) => AVAILABILITY_RANK[row.availability] > AVAILABILITY_RANK[top] ? row.availability : top, 'unavailable');

// The profile's device list. The computer is always exactly one entry, first, and cannot be
// forgotten: every browser and tab the agent signs in on is a connection of it, never a device
// of its own, whatever registrations exist (none at all included). Each phone or tablet is one
// entry however many times its app signed in, plus any handset registered only for push
// notifications; those are the ones "Forget" applies to, by their `deviceId`.
export async function listVoiceDevices(db, agentId) {
  const preference = (await db.query(`SELECT p.endpoint_id, e.kind FROM cc_agent_voice_preferences p
    LEFT JOIN cc_voice_endpoints e ON e.id=p.endpoint_id WHERE p.agent_id=$1`, [agentId])).rows[0];
  const rows = (await db.query(`SELECT e.id, e.device_id AS "deviceId", e.kind, e.form_factor AS "formFactor", e.label,
      e.created_at AS "registeredAt", COALESCE(e.last_seen_at, e.created_at) AS "lastSeenAt",
      ${voiceReachableSql('e')} AS reachable,
      CASE WHEN NOT ${voiceReachableSql('e')} THEN 'unavailable'
        WHEN e.ready AND e.socket_ready_until>now() THEN 'connected' ELSE 'standby' END AS availability,
      ${staleEndpointSql('e')} AS stale
    FROM cc_voice_endpoints e WHERE e.agent_id=$1 AND e.revoked_at IS NULL ORDER BY e.created_at DESC`, [agentId])).rows;
  // Handsets the alerts reach that hold no call registration: forgettable all the same.
  const pushOnly = (await db.query(`SELECT d.device_id AS "deviceId", d.kind, d.name, d.updated_at AS "lastSeenAt"
    FROM cc_mobile_devices d WHERE d.user_id=$1 AND d.kind IN ('ios','android')
      AND NOT EXISTS (SELECT 1 FROM cc_voice_endpoints e WHERE e.agent_id=d.user_id AND e.device_id=d.device_id AND e.revoked_at IS NULL)`, [agentId])).rows;
  const selectedId = preference?.endpoint_id || null;
  const browsers = rows.filter(row => row.kind === 'web');
  const computer = { id: 'computer', deviceId: null, kind: 'web', formFactor: null, label: defaultEndpointLabel('web'), removable: false,
    selected: preference?.kind === 'web', reachable: browsers.some(row => row.reachable), availability: best(browsers),
    stale: false, lastSeenAt: latest(browsers) };
  const phones = new Map();
  for (const row of rows) if (row.kind !== 'web') {
    const key = `${row.kind}:${row.deviceId}`;
    phones.set(key, [...(phones.get(key) || []), row]);
  }
  const mobile = [...phones.values()].map(group => {
    // Named and shaped by the registration that matters: the selected one, else the newest reachable, else the newest.
    const selectedRow = group.find(row => row.id === selectedId);
    const lead = selectedRow || group.find(row => row.reachable) || group[0];
    // Calls ring the selected registration's credential only, so a selected device reports that
    // registration's state: a newer reachable login of the same phone does not take its calls.
    const state = selectedRow
      ? { reachable: selectedRow.reachable, availability: selectedRow.availability, stale: selectedRow.stale, lastSeenAt: selectedRow.lastSeenAt }
      : { reachable: group.some(row => row.reachable), availability: best(group), stale: group.every(row => row.stale), lastSeenAt: latest(group) };
    return { id: lead.id, deviceId: lead.deviceId, kind: lead.kind, formFactor: lead.formFactor,
      label: endpointLabel({ ...lead, form_factor: lead.formFactor }), removable: true,
      selected: Boolean(selectedRow), ...state };
  });
  for (const device of pushOnly) mobile.push({ id: null, deviceId: device.deviceId, kind: device.kind, formFactor: null,
    label: device.name || defaultEndpointLabel(device.kind), removable: true, selected: false, reachable: false,
    availability: 'unavailable', stale: false, pushOnly: true, lastSeenAt: device.lastSeenAt });
  mobile.sort((a, b) => Number(b.selected) - Number(a.selected) || new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  return { endpointId: selectedId, devices: [computer, ...mobile] };
}

// Revoke one registration and free what it held: the row, its Telnyx credential and, for a
// phone, its login's push registration. Called for each registration of a forgotten phone and
// by the sweep; a swept one re-registers on its next launch. `release(credentialId)` deletes
// the Telnyx credential outside the transaction, since the provider call cannot roll back.
async function revokeEndpointRow(db, endpoint) {
  // The caller releases the credential right after this transaction: the row gives it up here so a
  // later registration of the same device provisions a fresh one instead of reusing a deleted one.
  await db.query("UPDATE cc_voice_endpoints SET revoked_at=now(),ready=false,push_ready=false,expires_at=now(),credential_id=NULL,sip_username=NULL WHERE id=$1", [endpoint.id]);
  await db.query("UPDATE acd_agent_sessions SET state='offline',capabilities='{}'::jsonb,expires_at=now() WHERE id=$1", [endpoint.id]);
  if (endpoint.kind !== 'web') await db.query('DELETE FROM cc_mobile_devices WHERE user_id=$1 AND device_id=$2 AND auth_session_id=$3',
    [endpoint.agent_id, endpoint.device_id, endpoint.auth_session_id]);
  // Selecting the device copied its credential onto the user as the canonical telephony identity, which
  // contacts and transfer targets fall back to: it must not outlive the credential.
  if (endpoint.credential_id) await db.query("UPDATE users SET telephony_credentials_id=NULL,telephony_user_name=NULL WHERE id=$1 AND telephony_credentials_id=$2",
    [endpoint.agent_id, endpoint.credential_id]);
  const preference = (await db.query("SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1", [endpoint.agent_id])).rows[0];
  if (preference?.endpoint_id === endpoint.id) {
    await db.query("UPDATE cc_agent_voice_preferences SET endpoint_id=NULL,generation=generation+1 WHERE agent_id=$1", [endpoint.agent_id]);
    await appendEvent(db, { agentId: endpoint.agent_id, type: 'voice_endpoint_changed', actor: `agent:${endpoint.agent_id}`, payload: { endpoint_id: null, reason: 'forgotten' } });
  }
}

// A registration revoked by a sign-out keeps its credential (the same login may come back and
// revive it). Once it is forgotten or swept, it gives the credential up like revokeEndpointRow.
async function releaseRevokedCredential(db, endpoint) {
  await db.query("UPDATE cc_voice_endpoints SET credential_id=NULL,sip_username=NULL WHERE id=$1 AND revoked_at IS NOT NULL", [endpoint.id]);
  if (endpoint.credential_id) await db.query("UPDATE users SET telephony_credentials_id=NULL,telephony_user_name=NULL WHERE id=$1 AND telephony_credentials_id=$2",
    [endpoint.agent_id, endpoint.credential_id]);
  const preference = (await db.query("SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1", [endpoint.agent_id])).rows[0];
  if (preference?.endpoint_id === endpoint.id) {
    await db.query("UPDATE cc_agent_voice_preferences SET endpoint_id=NULL,generation=generation+1 WHERE agent_id=$1", [endpoint.agent_id]);
    await appendEvent(db, { agentId: endpoint.agent_id, type: 'voice_endpoint_changed', actor: `agent:${endpoint.agent_id}`, payload: { endpoint_id: null, reason: 'forgotten' } });
  }
}

const computerIsPermanent = () => fail(409, 'The computer is your primary call device and cannot be forgotten.');

// "Forget" a phone or tablet: the whole installation, so a replaced or lost handset stops
// ringing and stops receiving notifications. Every registration of it is revoked and its Telnyx
// credentials freed (they carry its VoIP push binding), its push registration is deleted, and
// its app's logins are revoked, so it cannot quietly register again: it has to sign in anew.
// Never the computer, and never the login the request itself came from.
export async function forgetVoiceDevice(pool, user, deviceId, { release = async () => {} } = {}) {
  const agentId = String(user.id);
  if (!deviceId || String(deviceId).length > 128) throw fail(400, 'Unknown device.');
  const rows = await transaction(pool, agentId, async (db, state) => {
    const registrations = (await db.query('SELECT * FROM cc_voice_endpoints WHERE agent_id=$1 AND device_id=$2 AND revoked_at IS NULL FOR UPDATE',
      [agentId, String(deviceId)])).rows;
    if (registrations.some(row => row.kind === 'web')) throw computerIsPermanent();
    // Logins of this phone that were signed out earlier still hold their credentials.
    const signedOut = (await db.query("SELECT * FROM cc_voice_endpoints WHERE agent_id=$1 AND device_id=$2 AND revoked_at IS NOT NULL AND credential_id IS NOT NULL AND kind<>'web' FOR UPDATE",
      [agentId, String(deviceId)])).rows;
    const push = (await db.query("SELECT auth_session_id FROM cc_mobile_devices WHERE user_id=$1 AND device_id=$2 AND kind IN ('ios','android') FOR UPDATE",
      [agentId, String(deviceId)])).rows[0];
    if (!registrations.length && !push) throw fail(404, 'This device is no longer registered.');
    const preference = (await db.query("SELECT endpoint_id FROM cc_agent_voice_preferences WHERE agent_id=$1", [agentId])).rows[0];
    if (registrations.some(row => row.id === preference?.endpoint_id) && await hasVoiceWork(db, agentId, state)) throw fail(409, 'Finish the current call before forgetting the device that handles it.');
    for (const row of registrations) await revokeEndpointRow(db, row);
    for (const row of signedOut) await releaseRevokedCredential(db, row);
    // Whichever login registered it last: the push registration goes with the device, not with one login.
    await db.query('DELETE FROM cc_mobile_devices WHERE user_id=$1 AND device_id=$2', [agentId, String(deviceId)]);
    const logins = [...new Set([...registrations.map(row => row.auth_session_id), push?.auth_session_id])].filter(id => id && id !== user.authSessionId);
    if (logins.length) await db.query(`UPDATE users SET refresh_tokens=COALESCE((SELECT jsonb_agg(login) FROM jsonb_array_elements(COALESCE(refresh_tokens,'[]'::jsonb)) login
        WHERE NOT (login->>'sessionId' = ANY($2::text[]))),'[]'::jsonb), updated_at=now() WHERE id=$1`, [agentId, logins]);
    return [...registrations, ...signedOut];
  });
  // Each registration provisioned a credential of its own, so each is free now.
  for (const row of rows) if (row.credential_id) await release(row.credential_id);
  return listVoiceDevices(pool, agentId);
}

// The older form, by one registration's id: it forgets that registration's whole device.
export async function forgetVoiceEndpoint(pool, user, endpointId, options = {}) {
  const row = (await pool.query('SELECT kind, device_id FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL',
    [endpointId, String(user.id)])).rows[0];
  if (!row) throw fail(404, 'This device is no longer registered.');
  if (row.kind === 'web') throw computerIsPermanent();
  return forgetVoiceDevice(pool, user, row.device_id, options);
}

// Registrations unused for long enough are gone for good: the row is revoked and the Telnyx
// credential freed, so the connection stops accumulating credentials. A phone's after a month.
// A browser tab's connection of the computer after a day: each tab needs a credential of its
// own (Telnyx delivers a credential's calls to its latest registration only), and a closed tab
// never comes back; one that does registers afresh. The selected registration always stays.
export async function sweepStaleVoiceEndpoints(pool, { olderThanDays = 30, browserOlderThanHours = 24, revokedOlderThanHours = 1, limit = 50, release = async () => {} } = {}) {
  const unused = (e, days, hours) => `${e}.expires_at < now() - CASE WHEN ${e}.kind='web' THEN make_interval(hours => ${hours}) ELSE make_interval(days => ${days}) END`;
  const rows = (await pool.query(`SELECT e.* FROM cc_voice_endpoints e WHERE e.revoked_at IS NULL
    AND ${unused('e', '$1', '$3')} AND NOT ${voiceReachableSql('e')}
    AND NOT EXISTS (SELECT 1 FROM cc_agent_voice_preferences p WHERE p.endpoint_id=e.id)
    ORDER BY e.expires_at LIMIT $2`, [olderThanDays, limit, browserOlderThanHours])).rows;
  const swept = [];
  for (const row of rows) {
    const revoked = await transaction(pool, row.agent_id, async (db) => {
      // Re-checked under the agent's lock: a heartbeat or a selection since the candidate
      // query must keep the registration and its credential.
      const fresh = (await db.query(`SELECT e.* FROM cc_voice_endpoints e WHERE e.id=$1 AND e.revoked_at IS NULL
        AND ${unused('e', '$2', '$3')} AND NOT ${voiceReachableSql('e')}
        AND NOT EXISTS (SELECT 1 FROM cc_agent_voice_preferences p WHERE p.endpoint_id=e.id) FOR UPDATE OF e`, [row.id, olderThanDays, browserOlderThanHours])).rows[0];
      if (fresh) await revokeEndpointRow(db, fresh);
      return fresh;
    });
    if (!revoked) continue;
    if (revoked.credential_id) await release(revoked.credential_id);
    swept.push(revoked.id);
  }
  // A sign-out revokes the registration but keeps its credential, so the same login can come
  // back to it. Nothing else would ever free it once that login is gone: after an hour the
  // credential is released (a later registration of that login provisions a fresh one). The
  // selected registration keeps it until the agent chooses another device.
  const signedOut = (await pool.query(`SELECT e.* FROM cc_voice_endpoints e WHERE e.revoked_at IS NOT NULL AND e.credential_id IS NOT NULL
    AND e.revoked_at < now() - make_interval(hours => $2)
    AND NOT EXISTS (SELECT 1 FROM cc_agent_voice_preferences p WHERE p.endpoint_id=e.id)
    ORDER BY e.revoked_at LIMIT $1`, [limit, revokedOlderThanHours])).rows;
  for (const row of signedOut) {
    const released = await transaction(pool, row.agent_id, async (db) => {
      const fresh = (await db.query(`SELECT e.* FROM cc_voice_endpoints e WHERE e.id=$1 AND e.revoked_at IS NOT NULL AND e.credential_id IS NOT NULL
        AND e.revoked_at < now() - make_interval(hours => $2)
        AND NOT EXISTS (SELECT 1 FROM cc_agent_voice_preferences p WHERE p.endpoint_id=e.id) FOR UPDATE OF e`, [row.id, revokedOlderThanHours])).rows[0];
      if (fresh) await releaseRevokedCredential(db, fresh);
      return fresh;
    });
    if (!released) continue;
    await release(released.credential_id);
    swept.push(released.id);
  }
  return swept;
}
