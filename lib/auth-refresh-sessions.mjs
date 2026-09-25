import { getPostgresPool } from "./postgres.mjs";

export function refreshSessions(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function hasAuthSession(user, sessionId) {
  return refreshSessions(user?.refresh_tokens).some((entry) =>
    entry.sessionId === sessionId && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()));
}

// Serialize login, rotation and revocation on the same row. A read followed by
// an unguarded JSONB replacement loses another device's concurrent rotation.
export async function mutateRefreshSession(userId, { add = null, consume = null, revoke = null }, pool = getPostgresPool()) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const user = (await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [String(userId)])).rows[0];
    if (!user || user.active === false) throw Object.assign(new Error("Invalid session"), { status: 401 });
    const entries = refreshSessions(user.refresh_tokens).filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) > Date.now());
    const previous = consume && entries.find((entry) => entry.refreshToken === consume);
    if (consume && !previous) throw Object.assign(new Error("Refresh token not recognized"), { status: 401 });
    const remaining = entries.filter((entry) => entry.refreshToken !== consume && entry.refreshToken !== revoke);
    if (add) remaining.push({ ...add, sessionId: previous?.sessionId || add.sessionId });
    await db.query("UPDATE users SET refresh_tokens=$2::jsonb, updated_at=NOW() WHERE id=$1", [String(userId), JSON.stringify(remaining)]);
    await db.query("COMMIT");
    return { revoked: remaining.length < entries.length, sessionId: previous?.sessionId || add?.sessionId || null };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { db.release(); }
}
