import { NextResponse } from "next/server";
import {
  getSecretById,
  updateSecret,
  deleteSecret,
} from "@/lib/secrets";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, { params }, authz) {
  const user = authz.user;

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

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;

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

async function DELETE_handler(request, { params }, authz) {
  const user = authz.user;

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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("secrets:read", GET_handler, { route: "/api/admin/secrets/[id]" });
export const PUT = withPermission("secrets:update", PUT_handler, { route: "/api/admin/secrets/[id]" });
export const DELETE = withPermission("secrets:delete", DELETE_handler, { route: "/api/admin/secrets/[id]" });
