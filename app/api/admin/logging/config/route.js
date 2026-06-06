import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import {
  getRuntimeLoggingConfig,
  saveRuntimeLoggingConfig,
} from "@/lib/logger/runtime-config.mjs";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user || !isAdmin(user)) return null;
  return user;
}

function noStore(payload, init = {}) {
  return NextResponse.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

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

export async function PUT(request) {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

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
