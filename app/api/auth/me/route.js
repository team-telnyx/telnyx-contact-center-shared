import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getAuthenticatedUser } from "@/lib/auth-server";

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();

    if (!user) {
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
    const role = user.role || "agent";
    // Support both roles array and legacy role field
    const roles =
      user.roles && Array.isArray(user.roles) && user.roles.length > 0
        ? user.roles
        : [role];
    const status = user.status || "Available";
    const language =
      user.language || session?.user?.language || session?.user?.locale || null;

    return NextResponse.json({
      isAuth: true,
      user: {
        id: String(user.id || user._id),
        name,
        nick: user.nick || "",
        email,
        language,
        theme,
        role, // Keep for backward compatibility
        roles, // New roles array
        status,
        profilePictureUri: profilePictureUri || imageFromSession || null,
        smsNumber: user.sms_number || user.smsNumber || "Telnyx",
        mobile: user.mobile || "",
        voiceNumber: user.voice_number || user.voiceNumber || "",
        firstName: user.first_name || user.firstName || "",
        lastName: user.last_name || user.lastName || "",
      },
    });
  } catch (err) {
    console.error("[AUTH] /me error", err);
    return NextResponse.json({ isAuth: false });
  }
}
