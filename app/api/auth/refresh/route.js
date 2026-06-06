export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  hashToken,
} from "@/lib/jwt";
import { PgDb } from "@/lib/pgdb";

export async function POST(request) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const provided = match?.[1] || request.cookies.get("refresh_token")?.value;
    if (!provided) {
      return NextResponse.json(
        { error: "Missing refresh token" },
        { status: 401 }
      );
    }

    const payload = await verifyRefreshToken(provided);
    if (!payload?.sub) {
      return NextResponse.json(
        { error: "Invalid refresh token" },
        { status: 401 }
      );
    }

    const hashed = await hashToken(provided);
    const user = await PgDb.findUserById(String(payload.sub));

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    // Parse refresh_tokens if it's a JSON string
    let refreshTokens;
    try {
      refreshTokens =
        typeof user?.refresh_tokens === "string"
          ? JSON.parse(user.refresh_tokens)
          : user?.refresh_tokens;
    } catch (e) {
      console.error("Error parsing refresh_tokens:", e);
      refreshTokens = [];
    }

    const exists = Array.isArray(refreshTokens)
      ? refreshTokens.some((t) => t?.refreshToken === hashed)
      : false;
    if (!exists) {
      return NextResponse.json(
        { error: "Refresh token not recognized" },
        { status: 401 }
      );
    }

    // Rotate refresh token (remove old, add new)
    const newList = (refreshTokens || []).filter(
      (t) => t?.refreshToken !== hashed
    );

    const accessTokenTtlDays = 1;
    const refreshTokenTtlDays = 30;
    const accessToken = await signAccessToken(
      {
        sub: String(payload.sub),
      },
      `${accessTokenTtlDays}d`
    );
    const newRefreshToken = await signRefreshToken(
      { sub: String(payload.sub), purpose: "refresh" },
      `${refreshTokenTtlDays}d`
    );
    newList.push({ refreshToken: await hashToken(newRefreshToken) });
    await PgDb.updateUserById(String(payload.sub), { refresh_tokens: newList });

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
    console.error("Error in /api/auth/refresh:", err);
    return NextResponse.json(
      { error: "Server error", details: err.message },
      { status: 500 }
    );
  }
}
