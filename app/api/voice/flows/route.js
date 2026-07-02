import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import {
  createVoiceApplication,
  deleteVoiceApplication,
} from "@/lib/telnyx-voice-apps";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { validateFlow } from "@/lib/voice-flow-validator";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

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
 * Admin users can see all flows across the organization
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

    // Check if user is admin
    const id = session?.user?.id || null;
    const email = session.user.email;
    let user = null;
    if (id) user = await PgDb.findUserById(id);
    if (!user && email) user = await PgDb.findUserByUsername(email);

    // Admin users can see all flows (pass null username)
    // Non-admin users only see their own flows
    const username = user && isAdmin(user) ? null : email;

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

    // For each flow, query Telnyx to get phone numbers assigned to the voice application
    // Use filter[connection_id] where connection_id is the telnyx_voice_app_id
    const itemsWithPhoneNumbers = await Promise.all(
      result.items.map(async (flow) => {
        if (!flow.telnyx_voice_app_id) {
          return {
            ...flow,
            phone_numbers_count: 0,
            phone_numbers: [],
          };
        }

        try {
          // Query Telnyx API for phone numbers assigned to this voice application
          // Use connection_id filter as that's how Telnyx filters by call control application
          const basePath =
            process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

          let allPhoneNumbers = [];
          let page = 1;
          const pageSize = 250;
          let hasMore = true;

          while (hasMore) {
            const params = new URLSearchParams();
            params.set("page[number]", String(page));
            params.set("page[size]", String(pageSize));
            params.set("filter[connection_id]", flow.telnyx_voice_app_id);
            params.set("sort", "-purchased_at");

            const telnyxUrl = `${basePath}/v2/phone_numbers?${params.toString()}`;
            const res = await fetch(telnyxUrl, {
              headers: {
                Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
                "Content-Type": "application/json",
              },
            });

            if (!res.ok) {
              const errorText = await res.text();
              voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
              break;
            }

            const data = await res.json();
            const phoneNumbers = data.data || [];
            allPhoneNumbers.push(...phoneNumbers);

            // Check if there are more pages
            const totalPages = data.meta?.total_pages || 1;
            hasMore = page < totalPages;
            page++;
          }

          return {
            ...flow,
            phone_numbers_count: allPhoneNumbers.length,
            phone_numbers: allPhoneNumbers.map((pn) => pn.phone_number),
          };
        } catch (error) {
          voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
          return {
            ...flow,
            phone_numbers_count: 0,
            phone_numbers: [],
          };
        }
      })
    );

    return NextResponse.json({
      ok: true,
      items: itemsWithPhoneNumbers,
      total: result.total,
      page,
      pageSize,
    });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
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

    if (flowData.nodes.length > 0) {
      const validation = validateFlow({ nodes: flowData.nodes, edges: flowData.edges });
      if (!validation.valid) {
        return NextResponse.json(
          { ok: false, error: validation.errors.join("\n"), validation },
          { status: 400 }
        );
      }
    }

    // Generate webhook URL
    const flowId = body.id || require("crypto").randomUUID();
    const baseUrl = getBaseUrl();
    const webhookUrl = `${baseUrl}/api/voice/webhook/incoming/${flowId}`;

    // Create Telnyx Voice Application
    let voiceApp = null;
    try {
      // Ensure name is unique for Telnyx by appending a portion of the flow ID
      const telnyxAppName = `${flowData.name} (${flowId.substring(0, 8)})`;
      // Pass flowId as SIP subdomain
      voiceApp = await createVoiceApplication(
        telnyxAppName,
        webhookUrl,
        flowId
      );
    } catch (error) {
      voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
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
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to create flow" },
      { status: 500 }
    );
  }
}
