import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

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

export async function GET() {
  const user = await requireAdmin();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Missing TELNYX_API_KEY" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const pageSize = 250;
    let pageNumber = 1;
    const allSecrets = [];

    for (let safety = 0; safety < 10; safety += 1) {
      const url = buildTelnyxV2Url(
        `/integration_secrets?page[number]=${pageNumber}&page[size]=${pageSize}`,
      );
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return NextResponse.json(
          {
            ok: false,
            error: data?.errors?.[0]?.detail || `Telnyx API error: ${res.status}`,
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }

      const data = await res.json().catch(() => ({}));
      const chunk = Array.isArray(data?.data) ? data.data : [];
      allSecrets.push(
        ...chunk.map((secret) => ({
          id: secret?.id || "",
          identifier: secret?.identifier || "",
          type: secret?.type || "",
          created_at: secret?.created_at || secret?.createdAt || undefined,
        })),
      );

      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;
      pageNumber += 1;
    }

    return NextResponse.json(
      { ok: true, secrets: allSecrets },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
