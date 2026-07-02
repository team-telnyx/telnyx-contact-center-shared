import { NextResponse } from "next/server";
import { authenticateUser } from "@/lib/auth";
import { PgDb } from "@/lib/pgdb";
import { signAccessToken, signRefreshToken, hashToken } from "@/lib/jwt";
import { createUserTelephonyCredentials } from "@/lib/telnyx-credentials";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  try {
    const body = await request.json();
    const username = normalizeAuthEmail(body.username);
    const password = (body.password || "").toString();
    logAuthEvent("info", "signin_attempt", { method: "credentials", email: username, source: "api" });

    if (!username || !password) {
      logAuthEvent("warn", "signin_failed", { method: "credentials", email: username, source: "api", reason: "missing_required_fields" });
      return NextResponse.json(
        { error: "Please fill all the fields!" },
        { status: 400 }
      );
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      logAuthEvent("warn", "signin_failed", { method: "credentials", email: username, source: "api", reason: "invalid_credentials" });
      return NextResponse.json(
        { error: "Invalid email or password!" },
        { status: 401 }
      );
    }

    // Check if account is verified
    if (!user.verified && user.auth_strategy === "local") {
      logAuthEvent("warn", "signin_failed", { method: "credentials", source: "api", reason: "account_not_verified", ...authUserPayload(user, username) });
      return NextResponse.json(
        { error: "User account not verified yet!", verified: false },
        { status: 403 }
      );
    }

    // Check if user has telephony credentials, create if missing
    if (!user.telephony_credentials_id && !user.telephonyCredentialsId) {
      try {
        const credential = await createUserTelephonyCredentials({
          email: user.username || username,
          firstName: user.first_name || user.firstName || "",
          lastName: user.last_name || user.lastName || "",
        });

        if (credential) {
          // Update user with telephony credentials
          await PgDb.updateUserById(String(user.id || user._id), {
            telephonyCredentialsId: credential.id,
            telephonyUserName: credential.username || credential.sip_username,
          });
          logAuthEvent("info", "auth_telephony_credentials_created", {
            ...authUserPayload(user, username),
            credentialId: credential.id,
            source: "signin_api",
          });
          // Refresh user object to include new credentials
          const updatedUser = await PgDb.findUserById(
            String(user.id || user._id)
          );
          if (updatedUser) {
            Object.assign(user, updatedUser);
          }
        }
      } catch (credErr) {
        logAuthEvent("warn", "auth_telephony_credentials_failed", {
          ...authUserPayload(user, username),
          source: "signin_api",
          ...authErrorPayload(credErr),
        });
        // Continue login even if credential creation fails
      }
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

    const agentStatusResult = await pool.query(
      `SELECT agent_status FROM cc_agent_state WHERE user_id = $1`,
      [String(user.id || user._id)],
    );
    const currentAgentStatus =
      agentStatusResult.rows?.[0]?.agent_status || "Available";

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
      roles: user.roles || ["agent"],
      theme: user.theme || "system",
      language: user.language || null,
      profilePictureUri:
        user.profile_picture_uri || user.profilePictureUri || null,
      smsNumber: user.sms_number || user.smsNumber || "Telnyx",
      voiceNumber: user.voice_number || user.voiceNumber || "",
      status: currentAgentStatus,
      token: accessToken,
      refreshToken: refreshToken,
    };

    logAuthEvent("info", "signin_success", { method: "credentials", source: "api", ...authUserPayload(user, username) });
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
    logAuthEvent("error", "signin_failed", { source: "api", reason: "server_error", ...authErrorPayload(err) });
    return NextResponse.json(
      { error: "Server error", message: err.message },
      { status: 500 }
    );
  }
}
