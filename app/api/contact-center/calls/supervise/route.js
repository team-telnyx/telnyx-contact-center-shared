/**
 * Initiate a Telnyx supervisor call while reserving the supervisor's exclusive
 * voice capacity in ACD Core.
 * POST /api/contact-center/calls/supervise
 */

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { findInteractionViewByCallControlId } from "@/lib/acd/work-item-repository.mjs";
import { workItemInScope } from "@/lib/authz/scope.mjs";
import {
  rejectDirectIntent,
  reserveSupervisionVoice,
} from "@/lib/acd/direct-capacity.mjs";
import {
  supervisionLogger,
  contactCenterErrorPayload,
} from "@/lib/contact-center/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const VALID_ROLES = new Set(["monitor", "whisper", "barge"]);

function getTelnyxApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

function telnyxMessage(data, fallback) {
  const telnyxError = data?.errors?.[0] || {};
  return telnyxError.detail || telnyxError.message || data?.message || fallback;
}

async function POST_handler(request, _context, authz) {
  let supervisionIntent = null;
  try {
    const user = authz.user;

    const body = await request.json();
    const superviseCallControlId = String(
      body.supervise_call_control_id || "",
    ).trim();
    const role = String(body.supervisor_role || "").toLowerCase();
    if (!superviseCallControlId || !role) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: supervise_call_control_id, supervisor_role",
        },
        { status: 400 },
      );
    }
    if (!VALID_ROLES.has(role)) {
      return NextResponse.json(
        { error: "Invalid supervisor_role. Must be one of: monitor, whisper, barge" },
        { status: 400 },
      );
    }
    // Each mode is its own operation (calls:supervise.listen | whisper | barge).
    if (!authz.can(SUPERVISION_PERMISSION[role])) {
      return NextResponse.json({ error: "Forbidden", permission: SUPERVISION_PERMISSION[role] }, { status: 403 });
    }

    const connectionId = process.env.TELNYX_CALL_CONTROL_ID;
    if (!connectionId) {
      return NextResponse.json(
        { error: "TELNYX_CALL_CONTROL_ID not configured" },
        { status: 500 },
      );
    }
    const apiKey = getTelnyxApiKey();
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database unavailable" },
        { status: 503 },
      );
    }
    if (authz.scope?.restricted) {
      // Listen / whisper / barge reach only calls of interactions inside the caller's data scope.
      const supervised = await findInteractionViewByCallControlId(pool, superviseCallControlId);
      const inScope = supervised && (await workItemInScope(pool, authz.scope, supervised.work_item_id || supervised.id, { queueId: supervised.queue_id, agentId: supervised.agent_id, channel: supervised.interaction_type }));
      if (!inScope) return NextResponse.json({ ok: false, error: "Call is outside your data scope" }, { status: 403 });
    }

    const telephonyUserName =
      user.telephony_user_name ||
      user.telephonyUserName ||
      user.username?.split("@")[0] ||
      null;
    if (!telephonyUserName) {
      return NextResponse.json(
        {
          error:
            "Supervisor does not have telephony_user_name configured. Please set up telephony credentials in profile settings.",
        },
        { status: 400 },
      );
    }

    const supervisorSipUri = `sip:${telephonyUserName}@sip.telnyx.com`;
    supervisionIntent = await reserveSupervisionVoice(pool, {
      agentId: String(user.id),
      requestId: body.requestId,
      target: supervisorSipUri,
      supervisedCallControlId: superviseCallControlId,
      role,
    });

    const payload = {
      to: supervisorSipUri,
      connection_id: connectionId,
      supervise_call_control_id: superviseCallControlId,
      supervisor_role: role,
      from: process.env.TELNYX_SUPERVISOR_FROM_NUMBER || null,
      from_display_name: "Supervisor",
      custom_headers: [
        { name: "X-Supervisor-Call", value: "true" },
        { name: "X-CC-Direct-Intent-Id", value: supervisionIntent.id },
      ],
    };

    const response = await fetch(buildTelnyxV2Url("/calls"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const responseText = await response.text();
    let data = null;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch {
      // A successful but unreadable response has an unknown provider outcome.
      // Keep the Core reservation until webhook or reconciliation evidence.
      if (response.ok) {
        throw new Error(
          `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`,
        );
      }
    }

    if (!response.ok) {
      await rejectDirectIntent(pool, supervisionIntent.id, response.status);
      const errorMessage = telnyxMessage(
        data,
        `HTTP ${response.status}: Failed to create supervisor call`,
      );
      supervisionLogger.error("supervision_origination_rejected", {
        telnyxStatus: response.status,
        superviseCallControlId,
        supervisorRole: role,
        supervisionIntentId: supervisionIntent.id,
      });
      return NextResponse.json({ error: errorMessage }, { status: response.status });
    }

    const supervisorCall = data?.data;
    if (!supervisorCall?.call_control_id) {
      // An accepted response without the transport identifier is ambiguous;
      // reconciliation must prove absence before capacity can be released.
      return NextResponse.json(
        { error: "Invalid response from Telnyx: missing call_control_id" },
        { status: 500 },
      );
    }

    supervisionLogger.debug("supervision_origination_accepted", {
      superviseCallControlId,
      supervisorCallControlId: supervisorCall.call_control_id,
      supervisorRole: role,
      supervisionIntentId: supervisionIntent.id,
      supervisionWorkItemId: supervisionIntent.work_item_id,
    });
    return NextResponse.json({
      ok: true,
      supervisorCallControlId: supervisorCall.call_control_id,
      supervisorRole: role,
      supervisionIntentId: supervisionIntent.id,
      supervisionWorkItemId: supervisionIntent.work_item_id,
      message: `Supervisor call initiated in ${role} mode`,
    });
  } catch (error) {
    supervisionLogger.error("supervision_origination_failed", {
      ...contactCenterErrorPayload(error),
      supervisionIntentId: supervisionIntent?.id || null,
    });
    return NextResponse.json(
      { error: error.status ? error.message : "Failed to initiate supervisor call" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
const SUPERVISION_PERMISSION = { monitor: "calls:supervise.listen", whisper: "calls:supervise.whisper", barge: "calls:supervise.barge" };
export const POST = withPermission(Object.values(SUPERVISION_PERMISSION), POST_handler, { route: "/api/contact-center/calls/supervise" });
