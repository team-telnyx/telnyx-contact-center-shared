import { NextResponse } from "next/server";
import { applyLoggingPreset } from "@/lib/logger/runtime-config.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json().catch(() => ({}));
    const preset = body?.preset;
    const ttlMinutes = body?.ttlMinutes ?? null;
    const config = await applyLoggingPreset({
      preset,
      ttlMinutes,
      updatedBy: user.id || user.email || user.username || "admin",
    });
    return noStore({ ok: true, preset, config });
  } catch (error) {
    return noStore(
      { ok: false, error: error?.message || "Failed to apply logging preset" },
      { status: 400 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("logging:create", POST_handler, { route: "/api/admin/logging/presets" });
