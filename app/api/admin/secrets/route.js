import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import {
  getSecrets,
  createSecret,
} from "@/lib/secrets";

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

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const secrets = await getSecrets();
    return NextResponse.json({ secrets });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await request.json();
    const { name, description, value, expires_at } = body;

    if (!name || !value) {
      return NextResponse.json(
        { error: "Name and value are required" },
        { status: 400 }
      );
    }

    const secret = await createSecret({
      name: String(name).trim(),
      description: description ? String(description).trim() : "",
      value: String(value),
      expires_at: expires_at || null,
      created_by: user.id,
    });

    return NextResponse.json({ secret });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
