export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

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

// GET /api/admin/media-library/[mediaName]/stream - Stream media file for playback
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
    const url = buildTelnyxV2Url(
      `/media/${encodeURIComponent(mediaName)}/download`
    );

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Media Library] Stream error:", errorText);
      return NextResponse.json(
        { error: "Failed to stream media file" },
        { status: response.status }
      );
    }

    // Get the content type from the response
    const contentType = response.headers.get("content-type") || "audio/mpeg";

    // Stream the file
    const arrayBuffer = await response.arrayBuffer();
    return new NextResponse(arrayBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[Media Library] Stream error:", err);
    return NextResponse.json(
      { error: "Failed to stream media file" },
      { status: 500 }
    );
  }
}

