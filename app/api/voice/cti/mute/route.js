import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PolycomAPI } from "@/lib/cti/polycom-api";

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { phoneConfig } = body;

    if (!phoneConfig?.ip) {
      return NextResponse.json({ ok: false, error: "IP required" }, { status: 400 });
    }

    const result = await PolycomAPI.mute(phoneConfig);

    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.error, details: result }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
