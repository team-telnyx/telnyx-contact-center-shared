import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const userId = session.user.id;
  const email = session.user.email;
  let user = null;
  if (userId) user = await PgDb.findUserById(userId);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user || !isAdmin(user)) return null;
  return user;
}

export async function GET(request) {
  try {
    const user = await requireAdmin();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);

    // Build Telnyx API query parameters
    const params = new URLSearchParams();

    const country_code = searchParams.get("country_code");
    const national_destination_code = searchParams.get(
      "national_destination_code"
    );
    const locality = searchParams.get("locality");
    const administrative_area = searchParams.get("administrative_area");
    const rate_center = searchParams.get("rate_center");
    const phone_number_contains = searchParams.get("phone_number_contains");
    const phone_number_starts_with = searchParams.get(
      "phone_number_starts_with"
    );
    const phone_number_ends_with = searchParams.get("phone_number_ends_with");
    const phone_number_type = searchParams.get("phone_number_type");
    const features = searchParams.get("features");
    const limit = searchParams.get("limit") || "20";

    // Advanced search options
    const best_effort = searchParams.get("best_effort");
    const quickship = searchParams.get("quickship");
    const reservable = searchParams.get("reservable");
    const exclude_held_numbers = searchParams.get("exclude_held_numbers");
    const exclude_prev_owned_numbers = searchParams.get(
      "exclude_prev_owned_numbers"
    );
    const telnyx_bundle = searchParams.get("telnyx_bundle");
    const consecutive = searchParams.get("consecutive");

    if (country_code) {
      params.set("filter[country_code]", country_code);
    }
    if (national_destination_code) {
      params.set(
        "filter[national_destination_code]",
        national_destination_code
      );
    }
    if (locality) {
      params.set("filter[locality]", locality);
    }
    if (administrative_area) {
      params.set("filter[administrative_area]", administrative_area);
    }
    if (rate_center) {
      params.set("filter[rate_center]", rate_center);
    }
    if (phone_number_contains) {
      params.set("filter[phone_number][contains]", phone_number_contains);
    }
    if (phone_number_starts_with) {
      params.set("filter[phone_number][starts_with]", phone_number_starts_with);
    }
    if (phone_number_ends_with) {
      params.set("filter[phone_number][ends_with]", phone_number_ends_with);
    }
    if (phone_number_type) {
      params.set("filter[phone_number_type]", phone_number_type);
    }
    if (features) {
      const featureList = features.split(",");
      featureList.forEach((feature) => {
        params.append("filter[features]", feature.trim());
      });
    }

    // Advanced search options
    if (best_effort === "true") {
      params.set("filter[best_effort]", "true");
    }
    if (quickship === "true") {
      params.set("filter[quickship]", "true");
    }
    if (reservable === "true") {
      params.set("filter[reservable]", "true");
    }
    if (exclude_held_numbers === "true") {
      params.set("filter[exclude_held_numbers]", "true");
    }
    if (exclude_prev_owned_numbers === "true") {
      params.set("filter[exclude_prev_owned_numbers]", "true");
    }
    if (telnyx_bundle === "true") {
      params.set("filter[telnyx_bundle]", "true");
    }
    if (consecutive) {
      params.set("filter[consecutive]", consecutive);
    }

    params.set("filter[limit]", limit);

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const telnyxUrl = `${basePath}/v2/available_phone_numbers?${params.toString()}`;

    console.log(telnyxUrl);
    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Numbers Search API] Telnyx error:", errorText);
      return NextResponse.json(
        { error: "Failed to search phone numbers from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      data: data.data || [],
    });
  } catch (error) {
    console.error("[Numbers Search API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
