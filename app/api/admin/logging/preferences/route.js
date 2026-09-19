import { NextResponse } from "next/server";
import {
  getLoggingUserPreferences,
  saveLoggingUserPreferences,
} from "@/lib/logger/user-preferences.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function preferenceUserId(user) {
  return user.id || user.email || user.username;
}

async function GET_handler(_request, _context, authz) {
  const user = authz.user;

  try {
    const preferences = await getLoggingUserPreferences({ userId: preferenceUserId(user) });
    return noStore({ ok: true, preferences });
  } catch (error) {
    return noStore(
      { ok: false, error: error?.message || "Failed to read logging preferences" },
      { status: 500 },
    );
  }
}

async function PUT_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json().catch(() => ({}));
    const preferences = await saveLoggingUserPreferences({
      userId: preferenceUserId(user),
      filters: body?.filters || body?.preferences?.filters || {},
    });
    return noStore({ ok: true, preferences });
  } catch (error) {
    return noStore(
      { ok: false, error: error?.message || "Failed to save logging preferences" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("logging:read", GET_handler, { route: "/api/admin/logging/preferences" });
export const PUT = withPermission("logging:update", PUT_handler, { route: "/api/admin/logging/preferences" });
