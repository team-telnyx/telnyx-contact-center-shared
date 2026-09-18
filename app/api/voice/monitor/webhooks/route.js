import { NextResponse } from "next/server";

import { withPermission } from "@/lib/authz/guard";
// Stub endpoint to prevent 404 errors from health checks
// This endpoint is not actively used in the contact center app
async function GET_handler() {
  return NextResponse.json(
    {
      ok: true,
      webhooks: [],
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_flows:monitor", GET_handler, { route: "/api/voice/monitor/webhooks" });
