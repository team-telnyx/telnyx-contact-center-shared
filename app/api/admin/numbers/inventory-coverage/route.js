import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { error: "Telnyx API key not configured" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const countryCode = searchParams.get("country_code");
    const phoneNumberType = searchParams.get("phone_number_type");

    if (!countryCode) {
      return NextResponse.json(
        { error: "country_code parameter is required" },
        { status: 400 }
      );
    }

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    // Build query parameters
    const params = new URLSearchParams();
    params.set("filter[country_code]", countryCode);
    if (phoneNumberType) {
      params.set("filter[phone_number_type]", phoneNumberType);
    }
    params.set("filter[groupBy]", "npa");
    params.set("page[number]", "1");
    params.set("page[size]", "250");

    const url = `${basePath}/v2/inventory_coverage?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error:
            data?.errors?.[0]?.detail || "Failed to fetch inventory coverage",
        },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
