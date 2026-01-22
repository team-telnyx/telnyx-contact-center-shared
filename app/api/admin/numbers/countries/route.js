import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

// Country code to name mapping
const countryNames = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  AU: "Australia",
  NL: "Netherlands",
  SE: "Sweden",
  BE: "Belgium",
  CH: "Switzerland",
  AT: "Austria",
  DK: "Denmark",
  NO: "Norway",
  FI: "Finland",
  IE: "Ireland",
  PT: "Portugal",
  GR: "Greece",
  PL: "Poland",
  CZ: "Czech Republic",
  HU: "Hungary",
  RO: "Romania",
  BG: "Bulgaria",
  HR: "Croatia",
  SK: "Slovakia",
  SI: "Slovenia",
  LT: "Lithuania",
  LV: "Latvia",
  EE: "Estonia",
  CY: "Cyprus",
  MT: "Malta",
  LU: "Luxembourg",
  MX: "Mexico",
  BR: "Brazil",
  AR: "Argentina",
  CL: "Chile",
  CO: "Colombia",
  PE: "Peru",
  VE: "Venezuela",
  JP: "Japan",
  KR: "South Korea",
  CN: "China",
  IN: "India",
  SG: "Singapore",
  MY: "Malaysia",
  TH: "Thailand",
  ID: "Indonesia",
  PH: "Philippines",
  VN: "Vietnam",
  NZ: "New Zealand",
  ZA: "South Africa",
  EG: "Egypt",
  NG: "Nigeria",
  KE: "Kenya",
  IL: "Israel",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  TR: "Turkey",
  RU: "Russia",
  UA: "Ukraine",
};

import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

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

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

    // Fetch all phone numbers to get unique countries
    const telnyxUrl = `${basePath}/v2/phone_numbers?page[size]=250`;

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Countries API] Telnyx error:", errorText);
      return NextResponse.json(
        { error: "Failed to fetch phone numbers from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();
    const numbers = data.data || [];

    // Extract unique country codes
    const countryCodes = new Set();
    numbers.forEach((number) => {
      if (number.country_iso_alpha2) {
        countryCodes.add(number.country_iso_alpha2);
      }
    });

    // Convert to array of objects with code and name
    const countries = Array.from(countryCodes)
      .map((code) => ({
        code,
        name: countryNames[code] || code,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ countries });
  } catch (error) {
    console.error("[Countries API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
