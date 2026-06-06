import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

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

// GET /api/admin/scheduled-events - List all scheduled events across all assistants
export async function GET(request) {
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

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10))
    );
    const channel = searchParams.get("channel");
    const assistantId = searchParams.get("assistantId");

    // First, get all assistants
    const assistantsRes = await fetch(buildTelnyxV2Url("/ai/assistants"), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!assistantsRes.ok) {
      const text = await assistantsRes.text();
      return NextResponse.json(
        { error: `Failed to fetch assistants: ${text}` },
        { status: 502 }
      );
    }

    const assistantsData = await assistantsRes.json();
    const assistants = Array.isArray(assistantsData?.data)
      ? assistantsData.data
      : [];

    // Filter assistants if assistantId is provided
    const targetAssistants = assistantId
      ? assistants.filter((a) => a.id === assistantId)
      : assistants;

    // Fetch scheduled events for each assistant
    const allEvents = [];
    for (const assistant of targetAssistants) {
      try {
        const params = new URLSearchParams();
        params.set("page[size]", "100"); // Fetch more to aggregate
        if (channel) params.set("conversation_channel", channel);

        const eventsRes = await fetch(
          buildTelnyxV2Url(
            `/ai/assistants/${
              assistant.id
            }/scheduled_events?${params.toString()}`
          ),
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            cache: "no-store",
          }
        );

        if (eventsRes.ok) {
          const eventsData = await eventsRes.json();
          const events = Array.isArray(eventsData?.data) ? eventsData.data : [];
          events.forEach((event) => {
            allEvents.push({
              ...event,
              assistant_id: assistant.id,
              assistant_name: assistant.name,
            });
          });
        }
      } catch (err) {
        console.error(
          `Failed to fetch events for assistant ${assistant.id}:`,
          err
        );
      }
    }

    // Sort by scheduled_at_fixed_datetime descending
    allEvents.sort((a, b) => {
      const dateA = new Date(a.scheduled_at_fixed_datetime || 0);
      const dateB = new Date(b.scheduled_at_fixed_datetime || 0);
      return dateB - dateA;
    });

    // Apply pagination
    const total = allEvents.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedEvents = allEvents.slice(start, end);

    return NextResponse.json({
      rows: paginatedEvents,
      count: total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("[Scheduled Events API] Error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to fetch scheduled events" },
      { status: 500 }
    );
  }
}

// POST /api/admin/scheduled-events - Create a scheduled event
export async function POST(request) {
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

    const body = await request.json();
    const {
      assistant_id,
      telnyx_conversation_channel,
      telnyx_end_user_target,
      telnyx_agent_target,
      scheduled_at_fixed_datetime,
      text,
      conversation_metadata,
      max_retries_client_errors,
      retry_interval_secs,
    } = body;

    if (!assistant_id) {
      return NextResponse.json(
        { error: "assistant_id is required" },
        { status: 400 }
      );
    }

    if (!telnyx_conversation_channel) {
      return NextResponse.json(
        { error: "telnyx_conversation_channel is required" },
        { status: 400 }
      );
    }

    if (!telnyx_end_user_target) {
      return NextResponse.json(
        { error: "telnyx_end_user_target is required" },
        { status: 400 }
      );
    }

    if (!telnyx_agent_target) {
      return NextResponse.json(
        { error: "telnyx_agent_target is required" },
        { status: 400 }
      );
    }

    if (!scheduled_at_fixed_datetime) {
      return NextResponse.json(
        { error: "scheduled_at_fixed_datetime is required" },
        { status: 400 }
      );
    }

    const maxRetriesClientErrors = Number(max_retries_client_errors ?? 0);
    const retryIntervalSecs =
      retry_interval_secs === undefined ||
      retry_interval_secs === null ||
      retry_interval_secs === ""
        ? null
        : Number(retry_interval_secs);

    if (
      !Number.isInteger(maxRetriesClientErrors) ||
      maxRetriesClientErrors < 0 ||
      maxRetriesClientErrors > 10
    ) {
      return NextResponse.json(
        {
          error:
            "max_retries_client_errors must be an integer between 0 and 10",
        },
        { status: 400 }
      );
    }

    if (
      retryIntervalSecs !== null &&
      (!Number.isInteger(retryIntervalSecs) ||
        retryIntervalSecs < 60 ||
        retryIntervalSecs > 86400)
    ) {
      return NextResponse.json(
        { error: "retry_interval_secs must be an integer between 60 and 86400" },
        { status: 400 }
      );
    }

    if (maxRetriesClientErrors > 0 && retryIntervalSecs === null) {
      return NextResponse.json(
        {
          error:
            "retry_interval_secs is required when max_retries_client_errors is greater than 0",
        },
        { status: 400 }
      );
    }

    // Build request payload
    const payload = {
      telnyx_conversation_channel,
      telnyx_end_user_target,
      telnyx_agent_target,
      scheduled_at_fixed_datetime,
      max_retries_client_errors: maxRetriesClientErrors,
    };

    if (retryIntervalSecs !== null)
      payload.retry_interval_secs = retryIntervalSecs;
    if (text) payload.text = text;
    if (conversation_metadata)
      payload.conversation_metadata = conversation_metadata;

    const res = await fetch(
      buildTelnyxV2Url(`/ai/assistants/${assistant_id}/scheduled_events`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Scheduled Events API] Telnyx error:", errorText);
      return NextResponse.json(
        { error: `Telnyx API error: ${errorText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({ ok: true, data }, { status: 201 });
  } catch (err) {
    console.error("[Scheduled Events API] Error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to create scheduled event" },
      { status: 500 }
    );
  }
}

