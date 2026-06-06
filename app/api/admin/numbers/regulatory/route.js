export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

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
    const country = searchParams.get("country") || "US";
    const numberType = searchParams.get("number_type");

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    // Build query parameters
    const params = new URLSearchParams();
    params.set("filter[country_code]", country);
    if (numberType && numberType !== "all") {
      params.set("filter[phone_number_type]", numberType);
    }

    const url = `${basePath}/v2/regulatory_requirements?${params.toString()}`;

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
        { error: data?.errors?.[0]?.detail || "Failed to fetch requirements" },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[Regulatory API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
