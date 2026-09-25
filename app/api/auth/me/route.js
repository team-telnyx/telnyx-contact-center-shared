import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readEffectiveAgentStatus } from "@/lib/acd/agent-state.mjs";
import { authErrorPayload, authUserPayload, logAuthEvent } from "@/lib/auth-logging.mjs";
import { loadUserAccess } from "@/lib/authz/effective.mjs";

async function describeAccessSafely(user) {
  try {
    const { summary } = await loadUserAccess(user);
    return summary;
  } catch (err) {
    logAuthEvent("warn", "auth_profile_access_failed", { source: "api", ...authErrorPayload(err) });
    return null;
  }
}

async function getCurrentAgentStatus(userId) {
  if (!userId) return "Available";
  try {
    const pool = getPostgresPool();
    if (!pool) return "Available";
    return readEffectiveAgentStatus(pool, String(userId), "Offline");
  } catch (_) {
    return "Available";
  }
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();

    if (!user) {
      logAuthEvent("debug", "auth_profile_missing", { source: "api" });
      return NextResponse.json({ isAuth: false });
    }

    // Get session for additional metadata (like image from OAuth)
    const session = await getServerSession(authOptions);

    const nameParts = [
      user.first_name || user.firstName,
      user.last_name || user.lastName,
    ].filter(Boolean);
    const name = nameParts.length
      ? nameParts.join(" ")
      : user.username || user.email || "User";
    const email = user.username || user.email || "";
    const profilePictureUri =
      user.profile_picture_uri || user.profilePictureUri || null;
    const imageFromSession = session?.user?.image || null;
    const theme = user.theme || "system";
    // Use roles array exclusively
    const roles =
      user.roles && Array.isArray(user.roles) && user.roles.length > 0
        ? user.roles
        : ["agent"];
    const status = await getCurrentAgentStatus(user.id || user._id);
    const language =
      user.language || session?.user?.language || session?.user?.locale || null;
    const access = await describeAccessSafely(user);

    return NextResponse.json({
      isAuth: true,
      user: {
        id: String(user.id || user._id),
        name,
        nick: user.nick || "",
        email,
        language,
        theme,
        roles,
        permissions: access?.permissions || [],
        screens: access?.screens || [],
        scopes: access?.scopes || null,
        unknownRoles: access?.unknownRoles || [],
        status,
        profilePictureUri: profilePictureUri || imageFromSession || null,
        smsNumber: user.sms_number || user.smsNumber || "Telnyx",
        mobile: user.mobile || "",
        voiceNumber: user.voice_number || user.voiceNumber || "",
        mainFromNumber: process.env.TELNYX_MAIN_FROM_NUMBER || "",
        firstName: user.first_name || user.firstName || "",
        lastName: user.last_name || user.lastName || "",
      },
    });
  } catch (err) {
    logAuthEvent("warn", "auth_profile_failed", { source: "api", ...authErrorPayload(err) });
    return NextResponse.json({ error: "Profile temporarily unavailable" }, { status: 503 });
  }
}
