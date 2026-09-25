import { providerResponseStatus } from "@/lib/provider-http-status.mjs";
import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request) {
  try {
    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const query = new URL(request.url).searchParams;
    const paginated = query.has("pageSize");
    const size = paginated ? Math.min(25, Math.max(1, parseInt(query.get("pageSize"), 10) || 25)) : 250;
    const page = Math.max(1, parseInt(query.get("page"), 10) || 1);
    const telnyxUrl = `${basePath}/v2/messaging_profiles?page[size]=${size}&page[number]=${page}`;

    const res = await fetch(telnyxUrl, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to fetch messaging profiles from Telnyx" },
        { status: providerResponseStatus(res.status) }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      data: paginated ? (data.data || []).map(({ id, name }) => ({ id, name })) : data.data || [],
      ...(paginated ? { meta: { total: data.meta?.total_results ?? data.data?.length ?? 0 } } : {}),
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
export const GET = withPermission("messaging_admin:read", GET_handler, { route: "/api/admin/messaging-profiles" });
