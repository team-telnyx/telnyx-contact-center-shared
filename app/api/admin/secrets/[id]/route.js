import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import {
  getSecretById,
  updateSecret,
  deleteSecret,
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

export async function GET(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const resolvedParams = await params;
    const id = resolvedParams?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const secret = await getSecretById(Number(id));
    if (!secret) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ secret });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const resolvedParams = await params;
    const id = resolvedParams?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const body = await request.json();
    const { name, description, value, expires_at } = body;

    const updateData = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (description !== undefined)
      updateData.description = String(description).trim();
    if (value !== undefined) updateData.value = String(value);
    if (expires_at !== undefined)
      updateData.expires_at = expires_at || null;

    const secret = await updateSecret(Number(id), updateData);
    if (!secret) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ secret });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const resolvedParams = await params;
    const id = resolvedParams?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const secret = await deleteSecret(Number(id));
    if (!secret) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
