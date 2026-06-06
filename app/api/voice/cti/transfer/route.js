export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { PolycomAPI } from "@/lib/cti/polycom-api";

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { phoneConfig, number } = body;

    if (!phoneConfig?.ip || !number) {
      return NextResponse.json({ ok: false, error: "IP and transfer number required" }, { status: 400 });
    }

    // Usually Call Control API handles transfer, but we might need to implement refer or similar
    // For now, let's use sendRequest generic if transfer specific is not in helper
    // Assuming dial with type might work or separate endpoint
    // Actually Polycom REST API might not have explicit "transfer" in v1 callctrl, 
    // often it is done via REFER or simulating key presses.
    // Let's assume for now we don't have direct REST transfer, or use SIP REFER.
    // But user asked for REST API everywhere.
    
    // Fallback: Return error not implemented in REST, or try dial
    return NextResponse.json({ ok: false, error: "Transfer not supported in REST API implementation yet" }, { status: 501 });

  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
