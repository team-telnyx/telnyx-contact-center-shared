import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { resolveSimpleSecretReferences } from "@/lib/secrets";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

/**
 * POST /api/admin/web-pages/resolve-url
 * Resolves {{secret}} placeholders in a URL and returns the resolved URL
 * Only accessible by admins
 */
export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await request.json();
    const { url } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Resolve secret placeholders
    const resolvedUrl = await resolveSimpleSecretReferences(url);

    // Validate the resolved URL
    try {
      new URL(resolvedUrl);
    } catch {
      return NextResponse.json({ error: "Invalid URL after resolving secrets" }, { status: 400 });
    }

    return NextResponse.json({ resolvedUrl });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("[resolve-url] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
