import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || !["admin", "owner"].includes(session.user.role)) {
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
