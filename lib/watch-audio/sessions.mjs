import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { tryReserveCapacity } from '../acd/capacity.mjs';
import { activateWatchReservation, releaseWatchReservation } from '../acd/watch-reservations.mjs';
import { hasAuthSession } from '../auth-refresh-sessions.mjs';

export const CALL_LIMIT_MS = 30 * 60_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
let schema;
export function ensureWatchAudioSchema(pool) {
  return schema ||= pool.query(`CREATE TABLE IF NOT EXISTS watch_audio_sessions (
    id uuid PRIMARY KEY, user_id text NOT NULL, auth_session_id text NOT NULL,
    assistant_id text NOT NULL, token_hash text UNIQUE NOT NULL,
    state text NOT NULL DEFAULT 'issued', created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL, lease_until timestamptz NOT NULL,
    started_at timestamptz, ended_at timestamptz
  ); ALTER TABLE watch_audio_sessions ADD COLUMN IF NOT EXISTS target jsonb;
    ALTER TABLE watch_audio_sessions ADD COLUMN IF NOT EXISTS provider_call_id text;
    ALTER TABLE watch_audio_sessions ADD COLUMN IF NOT EXISTS call_state text;
    ALTER TABLE watch_audio_sessions ADD COLUMN IF NOT EXISTS dial_started_at timestamptz;
    CREATE INDEX IF NOT EXISTS watch_audio_user_idx ON watch_audio_sessions(user_id, created_at)`)
    .catch(error => { schema = null; throw error; });
}
export function watchAudioURL(env = process.env) {
  if (Number(env.WATCH_AUDIO_RELAY_REPLICAS || 1) !== 1) throw failure(503, 'Watch audio requires a single streaming worker.');
  const url = new URL(env.WS_BASE_URL || env.STREAMING_WS_URL || '');
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash)
    throw failure(503, 'Secure WS_BASE_URL is required for Watch audio.');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/watch-ai`;
  return url.href;
}
export async function issueWatchAudioTicket(pool, user, assistantId, env = process.env, target = null) {
  const url = watchAudioURL(env);
  if (!user.authSessionId || !hasAuthSession(user, user.authSessionId)) throw failure(401, 'Sign in again on your Watch.');
  await ensureWatchAudioSchema(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Serialize all devices for this user; only one AI audio call at a time.
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    await db.query("UPDATE watch_audio_sessions SET state='ended',ended_at=now() WHERE user_id=$1 AND state<>'ended' AND lease_until<now()", [String(user.id)]);
    const active = await db.query("SELECT id FROM watch_audio_sessions WHERE user_id=$1 AND state<>'ended'", [String(user.id)]);
    if (active.rowCount) throw failure(409, 'A Watch call is already starting or active on your account.');
    const recent = await db.query("SELECT count(*)::int AS count FROM watch_audio_sessions WHERE user_id=$1 AND created_at>now()-interval '1 minute'", [String(user.id)]);
    if (recent.rows[0].count >= 6) throw failure(429, 'Please wait before starting another call.');
    const token = randomBytes(32).toString('hex'), id = randomUUID();
    if (target) {
      const reserved = await tryReserveCapacity(db, { id, agentId:String(user.id), purpose:'watch_outbound', leaseMs:60_000 });
      if (!reserved) throw failure(409, 'Another voice or video call is already in progress.');
      await activateWatchReservation(db, id);
    }
    const expires = Date.now() + CALL_LIMIT_MS + (target ? 180_000 : 60_000);
    await db.query(`INSERT INTO watch_audio_sessions(id,user_id,auth_session_id,assistant_id,token_hash,expires_at,lease_until,target)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds',$7)`, [id,String(user.id),user.authSessionId,assistantId,digest(token),new Date(expires),target ? JSON.stringify(target) : null]);
    await db.query('COMMIT');
    // Retain only recent metadata; neither audio nor transcripts are persisted.
    await pool.query("DELETE FROM watch_audio_sessions s WHERE expires_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM acd_reservations r WHERE r.id=s.id AND r.state<>'released')").catch(() => {});
    return { url, token, expires };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
export function watchAudioStore(pool) {
  return {
    async authorize(req) {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if (!token) return null;
      await ensureWatchAudioSchema(pool);
      const result = await pool.query(`SELECT s.*, u.active, u.refresh_tokens FROM watch_audio_sessions s
        JOIN users u ON u.id::text=s.user_id WHERE s.token_hash=$1
        AND s.expires_at>now() AND ((s.lease_until>now() AND s.state<>'ended') OR ($2 AND s.ended_at>now()-interval '10 seconds'))`, [digest(token),req.method==='GET' && /^\/watch-ai\/session\/[a-f0-9-]{36}\/events(?:\?|$)/.test(req.url || '')]);
      const row = result.rows[0];
      return row && row.active !== false && hasAuthSession(row,row.auth_session_id) ? row : null;
    },
    async claim(id) {
      return (await pool.query(`UPDATE watch_audio_sessions SET state='active',started_at=now(),lease_until=now()+interval '45 seconds'
        WHERE id=$1 AND state='issued' AND lease_until>now() AND expires_at>now() RETURNING id`,[id])).rowCount === 1;
    },
    async heartbeat(id) {
      const result = await pool.query(`UPDATE watch_audio_sessions s SET lease_until=now()+interval '45 seconds'
        FROM users u WHERE s.id=$1 AND s.state='active' AND s.expires_at>now() AND s.lease_until>now()
        AND u.id::text=s.user_id AND u.active IS DISTINCT FROM false RETURNING s.auth_session_id,u.refresh_tokens`,[id]);
      return !!result.rows[0] && hasAuthSession(result.rows[0],result.rows[0].auth_session_id);
    },
    async end(id, confirmed = false) {
      await pool.query("UPDATE watch_audio_sessions SET state='ended',ended_at=COALESCE(ended_at,now()),lease_until=now() WHERE id=$1",[id]);
      // An uncertain Dial result must continue to occupy the phone until a
      // signed hangup, successful hangup command or the provider time limit.
      await releaseWatchReservation(pool, id, confirmed);
    },
    async beginDial(id) {
      return (await pool.query("UPDATE watch_audio_sessions SET dial_started_at=now(),call_state='dialing' WHERE id=$1 AND state='active' AND dial_started_at IS NULL RETURNING id",[id])).rowCount===1;
    },
    async dialed(id, callID) {
      await pool.query("UPDATE watch_audio_sessions SET provider_call_id=COALESCE(provider_call_id,$2) WHERE id=$1",[id,callID]);
    },
    async status(id) { return (await pool.query('SELECT * FROM watch_audio_sessions WHERE id=$1',[id])).rows[0]; },
    async stale() {
      await ensureWatchAudioSchema(pool);
      return (await pool.query(`SELECT s.* FROM watch_audio_sessions s JOIN acd_reservations r ON r.id=s.id
        WHERE s.target IS NOT NULL AND r.state<>'released' AND (s.state='ended' OR s.lease_until<now())`)).rows;
    },
  };
}
