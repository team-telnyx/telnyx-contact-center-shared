import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
import { loadNotificationSoundsForUser, saveNotificationSoundOverrides } from "@/lib/contact-center/notification-sounds.mjs";

// The signed-in user's interaction sounds: the system settings, their own
// overrides (only the fields they changed, or null) and the effective result.
async function GET_handler(request, _context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, ...(await loadNotificationSoundsForUser(pool, authz.user.id)) }, { headers: { "Cache-Control": "no-store" } });
}

async function PUT_handler(request, _context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("overrides" in body)) return NextResponse.json({ ok: false, error: "Send { overrides } (an object, or null to use the system settings)" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await saveNotificationSoundOverrides(pool, authz.user.id, body.overrides)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}

export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/notification-sounds" });
export const PUT = withPermission("authenticated", PUT_handler, { route: "/api/user/notification-sounds" });
