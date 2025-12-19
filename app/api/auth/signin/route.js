import { NextResponse } from "next/server";
import { authenticateUser } from "@/lib/auth";
import { PgDb } from "@/lib/pgdb";
import { signAccessToken, signRefreshToken, hashToken } from "@/lib/jwt";

export async function POST(request) {
  try {
    const body = await request.json();
    const username = (body.username || "").toString().trim().toLowerCase();
    const password = (body.password || "").toString();

    if (!username || !password) {
      return NextResponse.json(
        { error: "Please fill all the fields!" },
        { status: 400 }
      );
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password!" },
        { status: 401 }
      );
    }

    // Check if account is verified
    if (!user.verified && user.auth_strategy === "local") {
      return NextResponse.json(
        { error: "User account not verified yet!", verified: false },
        { status: 403 }
      );
    }

    const accessToken = await signAccessToken(
      {
        sub: String(user.id || user._id),
        email: user.username,
        username: user.username,
      },
      "1d"
    );

    const refreshToken = await signRefreshToken(
      { sub: String(user.id || user._id), purpose: "refresh" },
      "30d"
    );

    // Hash the refresh token before storing
    const hashedRefreshToken = await hashToken(refreshToken);

    // Replace all refresh tokens with the new one using direct SQL to ensure proper JSONB format
    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    const refreshTokensJson = JSON.stringify([
      { refreshToken: hashedRefreshToken },
    ]);
    await pool.query(
      `UPDATE users SET refresh_tokens = $1::jsonb, updated_at = $2 WHERE id = $3`,
      [refreshTokensJson, new Date().toISOString(), String(user.id || user._id)]
    );

    // Prepare user data for response
    const nameParts = [
      user.first_name || user.firstName,
      user.last_name || user.lastName,
    ].filter(Boolean);
    const name = nameParts.length
      ? nameParts.join(" ")
      : user.username || user.email || "User";
    const email = user.username || user.email || "";

    const userData = {
      id: String(user.id || user._id),
      username: email,
      email: email,
      name: name,
      nick: user.nick || nameParts[0] || "",
      firstName: user.first_name || user.firstName || "",
      lastName: user.last_name || user.lastName || "",
      mobile: user.mobile || "",
      verified: user.verified || false,
      role: user.role || "user",
      theme: user.theme || "system",
      language: user.language || null,
      profilePictureUri:
        user.profile_picture_uri || user.profilePictureUri || null,
      smsNumber: user.sms_number || user.smsNumber || "Telnyx",
      voiceNumber: user.voice_number || user.voiceNumber || "",
      status: user.status || "Available - ACD",
      token: accessToken,
      refreshToken: refreshToken,
    };

    const response = NextResponse.json(userData, { status: 200 });

    // Optionally set cookies (for web compatibility)
    response.cookies.set({
      name: "session",
      value: accessToken,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 1, // 1 day
    });

    response.cookies.set({
      name: "refresh_token",
      value: refreshToken,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });

    return response;
  } catch (err) {
    console.error("[API /auth/signin] Error:", err);
    return NextResponse.json(
      { error: "Server error", message: err.message },
      { status: 500 }
    );
  }
}
