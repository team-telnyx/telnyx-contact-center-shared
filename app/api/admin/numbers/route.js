import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request) {
  try {
    // `numbers:read` on the export already authenticated and authorised this
    // caller. The cookie lookup that stood here refused bearer-token clients
    // outright, and the user it then loaded "to check roles" was never read.


    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "10");
    const status = searchParams.get("status");
    const phone_number = searchParams.get("phone_number");
    const number_type = searchParams.get("number_type");
    const country = searchParams.get("country");

    // Build Telnyx API query parameters
    const params = new URLSearchParams();
    params.set("page[number]", String(page));
    params.set("page[size]", String(pageSize));

    if (status && status !== "all") {
      params.set("filter[status]", status);
    }
    if (phone_number) {
      params.set("filter[phone_number]", phone_number);
    }
    if (number_type && number_type !== "all") {
      params.set("filter[number_type][eq]", number_type);
    }
    if (country && country !== "all") {
      params.set("filter[country_iso_alpha2]", country);
    }

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const telnyxUrl = `${basePath}/v2/phone_numbers?${params.toString()}`;

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to fetch phone numbers from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      data: data.data || [],
      meta: {
        total:
          data.meta?.total_results ||
          data.meta?.total_count ||
          data.meta?.total ||
          0,
        total_results: data.meta?.total_results || 0,
        total_pages: data.meta?.total_pages || 0,
        page_number: data.meta?.page_number || page,
        page_size: data.meta?.page_size || pageSize,
      },
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
export const GET = withPermission("numbers:read", GET_handler, { route: "/api/admin/numbers" });
