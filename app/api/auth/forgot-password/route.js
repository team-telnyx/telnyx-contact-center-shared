import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/password-reset";
import { logAuthEvent } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body) {
    logAuthEvent("warn", "password_reset_request_failed", {
      reason: "invalid_json",
      source: "api",
    });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await requestPasswordReset(body.email, { source: "api" });
  if (result.ok) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(
    { error: result.error },
    { status: result.status || 500 },
  );
}
