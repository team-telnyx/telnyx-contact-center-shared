import { providerResponseStatus } from "@/lib/provider-http-status.mjs";
import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request) {
  try {
    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    const query = new URL(request.url).searchParams;
    if (query.has("pageSize")) {
      const sources = {
        texml: { path: "texml_applications", type: "TeXML" },
        "voice-api": { path: "call_control_applications", type: "Voice API" },
        sip: { path: "connections", type: "SIP" },
      };
      const source = sources[query.get("kind")];
      if (!source) return NextResponse.json({ error: "Invalid connection type" }, { status: 400 });
      const page = Math.max(1, parseInt(query.get("page"), 10) || 1);
      const size = Math.min(25, Math.max(1, parseInt(query.get("pageSize"), 10) || 25));
      const response = await fetch(`${basePath}/v2/${source.path}?page[size]=${size}&page[number]=${page}`, {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, cache: "no-store",
      });
      if (!response.ok) return NextResponse.json({ error: "Failed to fetch voice profiles from Telnyx" }, { status: providerResponseStatus(response.status) });
      const result = await response.json();
      const data = (result.data || []).map((item) => ({
        id: item.id,
        connection_name: item.connection_name || item.application_name || item.friendly_name || item.name || item.id,
        connection_type: source.type,
      }));
      return NextResponse.json({ data, meta: { total: result.meta?.total_results ?? data.length } },
        { headers: { "Cache-Control": "no-store" } });
    }

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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("system_settings:read", GET_handler, { route: "/api/admin/connections" });
