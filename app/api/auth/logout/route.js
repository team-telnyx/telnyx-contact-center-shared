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
