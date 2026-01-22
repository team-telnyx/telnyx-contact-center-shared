import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get full user object to check roles
    const userId = session.user.id;
    const email = session.user.email;
    let user = null;
    if (userId) user = await PgDb.findUserById(userId);
    if (!user && email) user = await PgDb.findUserByUsername(email);

    if (!user || !isAdmin(user)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const telnyxUrl = `${basePath}/v2/messaging_profiles?page[size]=250`;

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Messaging Profiles API] Telnyx error:", errorText);
      return NextResponse.json(
        { error: "Failed to fetch messaging profiles from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      data: data.data || [],
    });
  } catch (error) {
    console.error("[Messaging Profiles API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
