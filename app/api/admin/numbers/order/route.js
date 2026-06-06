export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
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

export async function POST(request) {
  try {
    const user = await requireAdmin();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { phone_numbers } = body;

    if (
      !phone_numbers ||
      !Array.isArray(phone_numbers) ||
      phone_numbers.length === 0
    ) {
      return NextResponse.json(
        { error: "phone_numbers array is required" },
        { status: 400 }
      );
    }

    const basePath = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
    const telnyxUrl = `${basePath}/v2/number_orders`;

    const res = await fetch(telnyxUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone_numbers: phone_numbers.map((num) => ({ phone_number: num })),
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Numbers Order API] Telnyx error:", errorText);
      return NextResponse.json(
        { error: "Failed to place number order with Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();

    return NextResponse.json({ data: data.data });
  } catch (error) {
    console.error("[Numbers Order API] Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
