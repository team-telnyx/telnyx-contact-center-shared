import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import {
  createVoiceApplication,
  deleteVoiceApplication,
} from "@/lib/telnyx-voice-apps";

export const dynamic = "force-dynamic";

/**
 * Get base URL for webhook generation
 */
function getBaseUrl() {
  // Try environment variable first
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL;
  }
  // Fallback for development
  if (process.env.NODE_ENV === "development") {
    return "http://localhost:3000";
  }
  // Production fallback (should be set via env var)
  return "https://your-domain.com";
}

/**
 * GET /api/voice/flows
 * List flows for authenticated user
 */
export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const username = session.user.email;
    const { searchParams } = new URL(request.url);

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "12", 10))
    );
    const name = searchParams.get("name") || "";

    const filters = {};
    if (name) filters.name = name;

    const pagination = { page, pageSize };

    const result = await VoiceFlowDb.listFlows(username, filters, pagination);

    return NextResponse.json({
      ok: true,
      items: result.items,
      total: result.total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("[API] Error listing flows:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to list flows" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/voice/flows
 * Create a new flow
 */
export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const username = session.user.email;
    const body = await request.json();

    const flowData = {
      name: body.name || "Untitled Flow",
      description: body.description || "",
      nodes: body.nodes || [],
      edges: body.edges || [],
      variables: body.globalVariables || body.variables || {},
      metadata: body.metadata || {},
    };

    // Generate webhook URL
    const flowId = body.id || require("crypto").randomUUID();
    const baseUrl = getBaseUrl();
    const webhookUrl = `${baseUrl}/api/voice/webhook/incoming/${flowId}`;

    // Create Telnyx Voice Application
    let voiceApp = null;
    try {
      voiceApp = await createVoiceApplication(flowData.name, webhookUrl);
    } catch (error) {
      console.error("[API] Failed to create voice application:", error);
      return NextResponse.json(
        {
          ok: false,
          error: `Failed to create voice application: ${error.message}`,
        },
        { status: 500 }
      );
    }

    // Create flow with voice app ID
    flowData.id = flowId;
    flowData.telnyx_voice_app_id = voiceApp.id;
    flowData.webhook_url = webhookUrl;

    const flow = await VoiceFlowDb.createFlow(username, flowData);

    return NextResponse.json({
      ok: true,
      flow,
    });
  } catch (error) {
    console.error("[API] Error creating flow:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to create flow" },
      { status: 500 }
    );
  }
}
