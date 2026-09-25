import { randomUUID } from "node:crypto";
import { mutateRefreshSession } from "@/lib/auth-refresh-sessions.mjs";
import { NextResponse } from "next/server";
import {
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  hashToken,
} from "@/lib/jwt";
import { PgDb } from "@/lib/pgdb";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const provided = match?.[1] || request.cookies.get("refresh_token")?.value;
    logAuthEvent("info", "refresh_attempt", { source: "api", refreshToken: "[REDACTED]" });
    if (!provided) {
      logAuthEvent("warn", "refresh_failed", { source: "api", reason: "missing_refresh_token", refreshToken: "[REDACTED]" });
      return NextResponse.json(
        { error: "Missing refresh token" },
        { status: 401 }
      );
    }

    const payload = await verifyRefreshToken(provided);
    if (!payload?.sub) {
      logAuthEvent("warn", "refresh_failed", { source: "api", reason: "invalid_refresh_token", refreshToken: "[REDACTED]" });
      return NextResponse.json(
        { error: "Invalid refresh token" },
        { status: 401 }
      );
    }

    const hashed = await hashToken(provided);
    const user = await PgDb.findUserById(String(payload.sub));

    if (!user || user.active === false) {
      logAuthEvent("warn", "refresh_failed", { source: "api", userId: String(payload.sub), reason: "user_not_found" });
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const sessionId = payload.sid || randomUUID();
    const accessTokenTtlDays = 1;
    const refreshTokenTtlDays = 30;
    const accessToken = await signAccessToken(
      {
        sub: String(payload.sub),
        sid: sessionId,
      },
      `${accessTokenTtlDays}d`
    );
    const newRefreshToken = await signRefreshToken(
      { sub: String(payload.sub), purpose: "refresh", sid: sessionId },
      `${refreshTokenTtlDays}d`
    );
    await mutateRefreshSession(String(payload.sub), {
      consume: hashed,
      add: { sessionId, refreshToken: await hashToken(newRefreshToken), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() },
    });
    logAuthEvent("info", "refresh_success", { source: "api", ...authUserPayload(user), rotatedRefreshToken: true });

    const res = NextResponse.json({
      ok: true,
      token: accessToken,
      tokenType: "Bearer",
      expiresIn: accessTokenTtlDays * 24 * 60 * 60,
      refreshToken: newRefreshToken,
      refreshTokenExpiresIn: refreshTokenTtlDays * 24 * 60 * 60,
    });
    res.cookies.set({
      name: "session",
      value: accessToken,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: accessTokenTtlDays * 24 * 60 * 60,
    });
    res.cookies.set({
      name: "refresh_token",
      value: newRefreshToken,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: refreshTokenTtlDays * 24 * 60 * 60,
    });
    return res;
  } catch (err) {
    logAuthEvent("error", "refresh_failed", { source: "api", reason: "server_error", ...authErrorPayload(err) });
    return NextResponse.json(
      { error: "Server error", details: err.message },
      { status: err.status || 500 }
    );
  }
}
