import { NextResponse } from "next/server";

// Stub endpoint to prevent 404 errors from health checks
// This endpoint is not actively used in the contact center app
export async function GET() {
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
