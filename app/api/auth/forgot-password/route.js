import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  try {
    const { email } = await request.json();
    const normalizedEmail = normalizeAuthEmail(email);
    logAuthEvent("info", "password_reset_requested", { email: normalizedEmail, source: "api" });
    if (!normalizedEmail) {
      logAuthEvent("warn", "password_reset_request_failed", { reason: "missing_email", source: "api" });
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }
    await PgDb.findUserByUsername(normalizedEmail);
    // No-op for security: always respond OK
    return NextResponse.json({ ok: true });
  } catch (err) {
    logAuthEvent("error", "password_reset_request_failed", { reason: "server_error", source: "api", ...authErrorPayload(err) });
    return NextResponse.json(
      { error: "Failed to request reset" },
      { status: 500 }
    );
  }
}
