import { getPostgresPool } from "@/lib/postgres.mjs";
import { revokeAuthVoiceEndpoints } from "@/lib/acd/voice-endpoints.mjs";
import { mutateRefreshSession } from "@/lib/auth-refresh-sessions.mjs";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { verifyAccessToken, verifyRefreshToken, hashToken } from "@/lib/jwt";
import { authErrorPayload, logAuthEvent } from "@/lib/auth-logging.mjs";
import {
  completeTrackedLogout,
  resolveTrackedAuthUser,
} from "@/lib/auth-session-tracking.mjs";

const NEXTAUTH_SESSION_COOKIE_BASES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

function expireAuthCookies(request, response) {
  const names = new Set(["session", "refresh_token", ...NEXTAUTH_SESSION_COOKIE_BASES]);
  for (const cookie of request.cookies.getAll()) {
    if (
      NEXTAUTH_SESSION_COOKIE_BASES.some(
        (base) => cookie.name === base || cookie.name.startsWith(`${base}.`),
      )
    ) {
      names.add(cookie.name);
    }
  }
  for (const name of names) {
    response.cookies.set({
      name,
      value: "",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: name.startsWith("__Secure-") || process.env.NODE_ENV === "production",
      expires: new Date(0),
      maxAge: 0,
    });
  }
}

export async function POST(request) {
  const res = NextResponse.json({ ok: true });
  try {
    const authHeader = request.headers.get("authorization") || "";
    const headerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const refreshCookie = request.cookies.get("refresh_token")?.value || null;
    const accessCookie = request.cookies.get("session")?.value || null;
    let nextAuthToken = null;
    try {
      nextAuthToken = await getToken({
        req: request,
        secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
      });
    } catch (nextAuthError) {
      await logAuthEvent("warn", "logout_session_decode_failed", {
        source: "api",
        ...authErrorPayload(nextAuthError),
      });
    }

    const bearerRefresh = headerMatch?.[1] || null;
    const bearerPayload = bearerRefresh ? await verifyRefreshToken(bearerRefresh) : null;
    if (bearerRefresh && !bearerPayload?.sub) {
      return NextResponse.json({ error: "Invalid refresh token" }, { status: 401 });
    }
    let userId = bearerPayload?.sub || null;
    if (!userId && accessCookie) {
      const p = await verifyAccessToken(accessCookie);
      if (p?.sub) userId = p.sub;
    }
    if (!userId && refreshCookie) {
      const p2 = await verifyRefreshToken(refreshCookie);
      if (p2?.sub) userId = p2.sub;
    }
    if (!userId && nextAuthToken?.id) userId = String(nextAuthToken.id);
    const email = nextAuthToken?.email || null;
    const refreshToRevoke = bearerRefresh || refreshCookie || null;
    let revokedRefreshToken = false;
    let trackedSessionClosed = false;
    await logAuthEvent("info", "logout_attempt", {
      userId: userId ? String(userId) : undefined,
      hasRefreshToken: Boolean(refreshToRevoke),
      hasNextAuthSession: Boolean(nextAuthToken),
      source: "api",
    });

    const user = await resolveTrackedAuthUser({ userId, email });
    if (user) {
      const refreshPayload = bearerPayload || (refreshToRevoke ? await verifyRefreshToken(refreshToRevoke) : null);
      await revokeAuthVoiceEndpoints(getPostgresPool(), user, refreshPayload?.sid || (!bearerRefresh ? nextAuthToken?.authTrackingSessionId : null));
    }
    if (user && refreshToRevoke) {
      const result = await mutateRefreshSession(String(user.id), { revoke: await hashToken(refreshToRevoke) });
      revokedRefreshToken = result.revoked;
    }

    if (user && nextAuthToken?.authTrackingSessionId && !bearerRefresh) {
      try {
        const trackingResult = await completeTrackedLogout({
          userId: String(user.id),
          email: user.username,
          sessionToken: nextAuthToken?.authTrackingSessionId || null,
          source: nextAuthToken ? "nextauth_logout_api" : "jwt_logout_api",
        });
        trackedSessionClosed = Boolean(trackingResult?.closed);
      } catch (activityError) {
        await logAuthEvent("warn", "logout_activity_failed", {
          userId: String(user.id),
          source: "api",
          ...authErrorPayload(activityError),
        });
      }
    }
    await logAuthEvent("info", "logout_success", {
      userId: user?.id ? String(user.id) : userId ? String(userId) : undefined,
      source: "api",
      hasRefreshToken: Boolean(refreshToRevoke),
      hasNextAuthSession: Boolean(nextAuthToken),
      revokedRefreshToken,
      trackedSessionClosed,
    });
  } catch (error) {
    await logAuthEvent("warn", "logout_failed", { source: "api", ...authErrorPayload(error) });
    return NextResponse.json({ error: "Could not revoke session. Please retry." }, { status: error.status || 503 });
  }

  expireAuthCookies(request, res);
  return res;
}
