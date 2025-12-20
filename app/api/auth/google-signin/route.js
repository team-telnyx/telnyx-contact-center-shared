import { NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { PgDb } from "@/lib/pgdb";
import { signAccessToken, signRefreshToken, hashToken } from "@/lib/jwt";
import { getPostgresPool } from "@/lib/postgres.mjs";

const client = new OAuth2Client(process.env.GOOGLE_ID);

export async function POST(request) {
  try {
    const body = await request.json();
    const idToken = body.idToken;

    if (!idToken) {
      return NextResponse.json(
        { error: "ID token is required!" },
        { status: 400 }
      );
    }

    // Verify the Google ID token
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return NextResponse.json({ error: "Invalid ID token!" }, { status: 401 });
    }

    const email = String(payload.email || "").toLowerCase();
    if (!email) {
      return NextResponse.json(
        { error: "Email not found in token!" },
        { status: 401 }
      );
    }

    // Find existing user (DO NOT CREATE NEW USER - sign-in only)
    const existing = await PgDb.findUserByUsername(email);

    if (!existing) {
      return NextResponse.json(
        { error: "Account not found. Please sign up first." },
        { status: 404 }
      );
    }

    // Update profile picture if available and not set
    const googleImage = payload.picture || "";
    if (!existing.profile_picture_uri && googleImage) {
      await PgDb.updateUserById(existing.id, {
        profile_picture_uri: googleImage,
      });
      existing.profile_picture_uri = googleImage;
    }

    // Generate JWT tokens (same as /api/auth/signin)
    const accessToken = await signAccessToken(
      {
        sub: String(existing.id),
        email: existing.username,
        username: existing.username,
      },
      "1d"
    );

    const refreshToken = await signRefreshToken(
      { sub: String(existing.id), purpose: "refresh" },
      "30d"
    );

    // Hash and store refresh token
    const hashedRefreshToken = await hashToken(refreshToken);
    const pool = getPostgresPool();
    const refreshTokensJson = JSON.stringify([
      { refreshToken: hashedRefreshToken },
    ]);
    await pool.query(
      `UPDATE users SET refresh_tokens = $1::jsonb, updated_at = $2 WHERE id = $3`,
      [refreshTokensJson, new Date().toISOString(), String(existing.id)]
    );

    // Prepare user data (same format as /api/auth/signin)
    const nameParts = [
      existing.first_name || existing.firstName,
      existing.last_name || existing.lastName,
    ].filter(Boolean);
    const name = nameParts.length
      ? nameParts.join(" ")
      : existing.username || "User";

    const userData = {
      id: String(existing.id),
      username: email,
      email: email,
      name: name,
      nick: existing.nick || nameParts[0] || "",
      firstName: existing.first_name || existing.firstName || "",
      lastName: existing.last_name || existing.lastName || "",
      mobile: existing.mobile || "",
      verified: existing.verified || false,
      role: existing.role || "agent",
      theme: existing.theme || "system",
      language: existing.language || null,
      profilePictureUri:
        existing.profile_picture_uri ||
        existing.profilePictureUri ||
        googleImage ||
        null,
      smsNumber: existing.sms_number || existing.smsNumber || "Telnyx",
      voiceNumber: existing.voice_number || existing.voiceNumber || "",
      status: existing.status || "Available - ACD",
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
    console.error("[API /auth/google-signin] Error:", err);
    return NextResponse.json(
      { error: "Server error", message: err.message },
      { status: 500 }
    );
  }
}
