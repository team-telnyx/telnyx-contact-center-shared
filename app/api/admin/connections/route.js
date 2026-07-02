import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

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

    // Fetch all three types of connections with large page size to get all records
    const [texmlRes, voiceApiRes, sipRes] = await Promise.all([
      fetch(`${basePath}/v2/texml_applications?page[size]=250`, {
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }),
      fetch(`${basePath}/v2/call_control_applications?page[size]=250`, {
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }),
      fetch(`${basePath}/v2/connections?page[size]=250`, {
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }),
    ]);

    const allConnections = [];

    // Process TeXML applications
    if (texmlRes.ok) {
      const texmlData = await texmlRes.json();
      const texmlApps = (texmlData.data || []).map((app) => ({
        ...app,
        connection_name: app.friendly_name || app.name || app.id,
        connection_type: "TeXML",
      }));
      allConnections.push(...texmlApps);
    }

    // Process Voice API (Call Control) applications
    if (voiceApiRes.ok) {
      const voiceApiData = await voiceApiRes.json();
      const voiceApiApps = (voiceApiData.data || []).map((app) => ({
        ...app,
        connection_name: app.application_name || app.friendly_name || app.id,
        connection_type: "Voice API",
      }));
      allConnections.push(...voiceApiApps);
    }

    // Process SIP connections
    if (sipRes.ok) {
      const sipData = await sipRes.json();
      const sipConnections = (sipData.data || []).map((conn) => ({
        ...conn,
        connection_name: conn.connection_name || conn.name || conn.id,
        connection_type: "SIP",
      }));
      allConnections.push(...sipConnections);
    }

    return NextResponse.json({
      data: allConnections,
    });
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
