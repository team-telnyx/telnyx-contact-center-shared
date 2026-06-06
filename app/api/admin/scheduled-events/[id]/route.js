export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

async function requireSupervisorOrAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isSupervisorOrAdmin(user)) return null;
  return user;
}

// GET /api/admin/scheduled-events/[id] - Get a specific scheduled event
export async function GET(request, { params }) {
  const user = await requireSupervisorOrAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const resolvedParams = await params;
    const eventId = resolvedParams.id;
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");

    if (!assistantId) {
      return NextResponse.json(
        { error: "assistantId query parameter is required" },
        { status: 400 }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(
        `/ai/assistants/${assistantId}/scheduled_events/${eventId}`
      ),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { error: `Telnyx API error: ${errorText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[Scheduled Events API] Error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to fetch scheduled event" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/scheduled-events/[id] - Delete a scheduled event
export async function DELETE(request, { params }) {
  const user = await requireSupervisorOrAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const resolvedParams = await params;
    const eventId = resolvedParams.id;
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");

    if (!assistantId) {
      return NextResponse.json(
        { error: "assistantId query parameter is required" },
        { status: 400 }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(
        `/ai/assistants/${assistantId}/scheduled_events/${eventId}`
      ),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { error: `Telnyx API error: ${errorText}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Scheduled Events API] Error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to delete scheduled event" },
      { status: 500 }
    );
  }
}

