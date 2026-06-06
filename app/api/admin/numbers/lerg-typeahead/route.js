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
    const query = searchParams.get("query");
    const countryIso = searchParams.get("country_iso");

    if (!query || query.length < 3) {
      return NextResponse.json(
        { error: "query parameter must be at least 3 characters" },
        { status: 400 }
      );
    }

    if (!countryIso) {
      return NextResponse.json(
        { error: "country_iso parameter is required" },
        { status: 400 }
      );
    }

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    const params = new URLSearchParams();
    params.set("query", query);
    params.set("country_iso", countryIso);

    const url = `${basePath}/v2/lerg/typeahead?${params.toString()}`;

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
            data?.errors?.[0]?.detail || "Failed to fetch typeahead results",
        },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[LERG Typeahead API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
