import { NextResponse } from "next/server";
import {
  getRuntimeLoggingConfig,
  saveRuntimeLoggingConfig,
} from "@/lib/logger/runtime-config.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

async function GET_handler(_request, _context, authz) {
  const user = authz.user;

  try {
    const config = await getRuntimeLoggingConfig({ forceRefresh: true });
    return noStore({ ok: true, config });
  } catch (error) {
    return noStore(
      { ok: false, error: error?.message || "Failed to read logging config" },
      { status: 500 },
    );
  }
}

async function PUT_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json().catch(() => ({}));
    const requestedConfig = body?.config || body || {};
    const allowedConfigKeys = [
      "enabled",
      "globalLevel",
      "consoleEnabled",
      "consolePretty",
      "consoleFriendly",
      "fileEnabled",
      "rotationMode",
      "retentionDays",
      "liveEnabled",
      "liveTtlMinutes",
      "archiveEnabled",
      "archiveProvider",
      "archivePrefix",
      "spoolEnabled",
      "topicLevels",
      "topicEnabled",
    ];
    const safeConfig = {};
    for (const key of allowedConfigKeys) {
      if (Object.hasOwn(requestedConfig, key)) safeConfig[key] = requestedConfig[key];
    }
    safeConfig.redactionEnabled = true;
    const config = await saveRuntimeLoggingConfig({
      config: safeConfig,
      updatedBy: user.id || user.email || user.username || "admin",
    });
    return noStore({ ok: true, config });
  } catch (error) {
    return noStore(
      { ok: false, error: error?.message || "Failed to update logging config" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("logging:read", GET_handler, { route: "/api/admin/logging/config" });
export const PUT = withPermission("logging:update", PUT_handler, { route: "/api/admin/logging/config" });
