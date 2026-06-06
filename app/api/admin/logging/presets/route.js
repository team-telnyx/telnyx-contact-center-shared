import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { applyLoggingPreset } from "@/lib/logger/runtime-config.mjs";

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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

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
