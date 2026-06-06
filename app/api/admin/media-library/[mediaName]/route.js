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
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

// GET /api/admin/media-library/[mediaName] - Get a specific media file
export async function GET(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const resolvedParams = await params;
    const mediaName = resolvedParams?.mediaName;

    if (!mediaName) {
      return NextResponse.json(
        { error: "Media name is required" },
        { status: 400 }
      );
    }

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(`/media/${encodeURIComponent(mediaName)}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Media Library] GET error:", errorText);
      return NextResponse.json(
        { error: "Failed to fetch media file" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, data: data.data || data });
  } catch (err) {
    console.error("[Media Library] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load media file" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/media-library/[mediaName] - Delete a media file
export async function DELETE(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const resolvedParams = await params;
    const mediaName = resolvedParams?.mediaName;

    if (!mediaName) {
      return NextResponse.json(
        { error: "Media name is required" },
        { status: 400 }
      );
    }

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(`/media/${encodeURIComponent(mediaName)}`);

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Media Library] DELETE error:", errorText);
      return NextResponse.json(
        { error: "Failed to delete media file" },
        { status: response.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Media Library] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete media file" },
      { status: 500 }
    );
  }
}

