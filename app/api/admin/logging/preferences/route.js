import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import {
  getLoggingUserPreferences,
  saveLoggingUserPreferences,
} from "@/lib/logger/user-preferences.mjs";

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

function preferenceUserId(user) {
  return user.id || user.email || user.username;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

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

export async function PUT(request) {
  const user = await requireAdmin();
  if (!user) return noStore({ ok: false, error: "Forbidden" }, { status: 403 });

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
