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
      console.error("[Numbers API] Telnyx error:", errorText);
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
    console.error("[Numbers API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
