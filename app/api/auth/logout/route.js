import { NextResponse } from "next/server";
import { verifyAccessToken, verifyRefreshToken, hashToken } from "@/lib/jwt";
import { PgDb } from "@/lib/pgdb";

export async function POST(request) {
  const res = NextResponse.json({ ok: true });
  try {
    const authHeader = request.headers.get("authorization") || "";
    const headerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const refreshCookie = request.cookies.get("refresh_token")?.value || null;
    const accessCookie = request.cookies.get("session")?.value || null;

    let userId = null;
    if (accessCookie) {
      const p = await verifyAccessToken(accessCookie);
      if (p?.sub) userId = p.sub;
    }
    if (!userId && refreshCookie) {
      const p2 = await verifyRefreshToken(refreshCookie);
      if (p2?.sub) userId = p2.sub;
    }
    const refreshToRevoke = refreshCookie || headerMatch?.[1] || null;
    if (userId && refreshToRevoke) {
      const user = await PgDb.findUserById(String(userId));
      const list = Array.isArray(user?.refresh_tokens)
        ? user.refresh_tokens
        : [];
      const hashed = await hashToken(refreshToRevoke);
      const newList = list.filter((t) => t?.refreshToken !== hashed);
      await PgDb.updateUserById(String(userId), { refresh_tokens: newList });

      // Track logout activity
      try {
        // Find the most recent login session that hasn't been logged out
        const pool = await import("@/lib/postgres.mjs").then((m) =>
          m.getPostgresPool()
        );
        if (pool) {
          const sessionRes = await pool.query(
            `SELECT id, login_at, session_token FROM cc_user_sessions 
             WHERE user_id = $1 AND logout_at IS NULL 
             ORDER BY login_at DESC LIMIT 1`,
            [String(userId)]
          );

          if (sessionRes.rows.length > 0) {
            const session = sessionRes.rows[0];
            const logoutTime = new Date().toISOString();
            let durationSeconds = null;
            if (session.login_at) {
              durationSeconds = Math.floor(
                (new Date(logoutTime) - new Date(session.login_at)) / 1000
              );
            }

            // Update session with logout time (use session_token if available, otherwise use id)
            if (session.session_token) {
              await PgDb.updateUserSessionLogout(
                session.session_token,
                logoutTime
              );
            } else {
              // Fallback: update by ID
              await pool.query(
                `UPDATE cc_user_sessions 
                 SET logout_at = $1, 
                     duration_seconds = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [logoutTime, durationSeconds, session.id]
              );
            }

            // Log logout activity
            await PgDb.logUserActivity({
              userId: String(userId),
              activityType: "logout",
              startedAt: session.login_at || logoutTime,
              endedAt: logoutTime,
              durationSeconds: durationSeconds,
            });
          } else {
            // No active session found, just log the logout activity
            await PgDb.logUserActivity({
              userId: String(userId),
              activityType: "logout",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
            });
          }
        }
      } catch (activityError) {
        console.error("[Logout] Failed to log logout activity:", activityError);
        // Don't fail logout if activity logging fails
      }
    }
  } catch (_) {}

  res.cookies.set({
    name: "session",
    value: "",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  res.cookies.set({
    name: "refresh_token",
    value: "",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  return res;
}
