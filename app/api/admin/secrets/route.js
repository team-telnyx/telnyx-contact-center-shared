import { NextResponse } from "next/server";
import {
  getSecrets,
  createSecret,
} from "@/lib/secrets";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const secrets = await getSecrets();
    return NextResponse.json({ ok: true, secrets });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;

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

    return NextResponse.json({ ok: true, secret });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("secrets:read", GET_handler, { route: "/api/admin/secrets" });
export const POST = withPermission("secrets:create", POST_handler, { route: "/api/admin/secrets" });
