import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// POST /api/admin/scheduled-events/import - Import scheduled events from CSV
async function POST_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { events } = body;

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json(
        { error: "events array is required and must not be empty" },
        { status: 400 }
      );
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [],
    };

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const {
        assistant_id,
        telnyx_conversation_channel,
        telnyx_end_user_target,
        telnyx_agent_target,
        scheduled_at_fixed_datetime,
        text,
        max_retries_client_errors,
        retry_interval_secs,
      } = event;

      // Validate required fields
      if (!assistant_id) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "assistant_id is required",
        });
        continue;
      }

      if (!telnyx_conversation_channel) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "telnyx_conversation_channel is required",
        });
        continue;
      }

      if (!telnyx_end_user_target) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "telnyx_end_user_target is required",
        });
        continue;
      }

      if (!telnyx_agent_target) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "telnyx_agent_target is required",
        });
        continue;
      }

      if (!scheduled_at_fixed_datetime) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "scheduled_at_fixed_datetime is required",
        });
        continue;
      }

      // Validate datetime format
      const datetime = new Date(scheduled_at_fixed_datetime);
      if (isNaN(datetime.getTime())) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "Invalid scheduled_at_fixed_datetime format (use ISO 8601)",
        });
        continue;
      }

      const maxRetriesClientErrors = Number(max_retries_client_errors || 0);
      const retryIntervalSecs = retry_interval_secs
        ? Number(retry_interval_secs)
        : null;

      if (
        !Number.isInteger(maxRetriesClientErrors) ||
        maxRetriesClientErrors < 0 ||
        maxRetriesClientErrors > 10
      ) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "max_retries_client_errors must be an integer between 0 and 10",
        });
        continue;
      }

      if (
        retryIntervalSecs !== null &&
        (!Number.isInteger(retryIntervalSecs) ||
          retryIntervalSecs < 60 ||
          retryIntervalSecs > 86400)
      ) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: "retry_interval_secs must be an integer between 60 and 86400",
        });
        continue;
      }

      if (maxRetriesClientErrors > 0 && retryIntervalSecs === null) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error:
            "retry_interval_secs is required when max_retries_client_errors is greater than 0",
        });
        continue;
      }

      // Build payload
      const payload = {
        telnyx_conversation_channel,
        telnyx_end_user_target,
        telnyx_agent_target,
        scheduled_at_fixed_datetime: datetime.toISOString(),
        max_retries_client_errors: maxRetriesClientErrors,
      };

      if (retryIntervalSecs !== null)
        payload.retry_interval_secs = retryIntervalSecs;
      if (text) payload.text = text;

      // Create the scheduled event
      try {
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

        if (res.ok) {
          results.success++;
        } else {
          const errorText = await res.text();
          results.failed++;
          results.errors.push({
            row: i + 1,
            error: `Telnyx API error: ${errorText}`,
          });
        }
      } catch (err) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          error: err.message || "Failed to create event",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      results,
    });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: err.message || "Failed to import scheduled events" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("scheduled_events:import", POST_handler, { route: "/api/admin/scheduled-events/import" });
