import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, describeShape, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { callMcpTool } from "@/lib/mcp/mcp-tool-runner";
import { DEFAULT_TOOL_ARGUMENTS, unwrapToolPayload } from "@/lib/agent-assist/slot-mcp-execute";
import { normalizeSlotMcpBinding } from "@/lib/agent-assist/slot-mcp-runner.mjs";
import { interactionAgentMatches } from "@/lib/contact-center/interaction-agent-access.mjs";
import { withPermission } from "@/lib/authz/guard";

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

// authSession.user.username is derived from the JWT's token.email, captured
// at login — a username rename or email-fallback login after that can leave
// it stale relative to Core assignment. A fresh by-id lookup
// is the second candidate identity, same pattern as mcp-submit/route.js.
async function getUsernameForUserId(pool, userId) {
  if (!pool || !userId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT username FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return row?.username || null;
}

// get_active_transports has no per-trip filter in its declared input schema
// (only systemId/contractId/facilityId/levelOfService) — it returns every
// active transport for the contract, and the caller has to find its own
// trip within the list. Rather than guess which field carries the trip id
// (the response shape was never documented before this route existed),
// search every (possibly nested) field for an EXACT match on the trip id.
//
// Codex review (PR #1396, P1): the original version checked whether the
// trip id was merely a SUBSTRING of the entry's whole serialized JSON. A
// trip id that is itself a substring of another value (or of a different
// trip's id, e.g. numeric ids "123" vs "1234") would match the WRONG
// entry, returning a different transport's patient/location data to an
// agent authorized only for their own session. Requiring an exact value
// match on some leaf field closes that without needing to know the real
// field name up front.
function findTripInList(list, tripId) {
  const needle = String(tripId);
  const hasExactMatch = (value, depth = 0) => {
    if (depth > 6) return false;
    if (value === null || value === undefined) return false;
    if (typeof value === "string" || typeof value === "number") return String(value) === needle;
    if (Array.isArray(value)) return value.some((entry) => hasExactMatch(entry, depth + 1));
    if (typeof value === "object") return Object.values(value).some((entry) => hasExactMatch(entry, depth + 1));
    return false;
  };
  return list.find((entry) => hasExactMatch(entry)) || null;
}

// create_transport's `outputs` map is { targetSlotName: pathInResult } -
// this workflow's binding declares { transport_olos_trip_id: "olos_trip_id" },
// but a differently-configured workflow could name the target slot anything.
// Resolve the ACTUAL slot name generically instead of hardcoding this
// workflow's own choice (Codex review, PR #1396, P2).
function findOutputSlotName(binding, resultPath) {
  const outputs = binding?.outputs || {};
  for (const [slotName, path] of Object.entries(outputs)) {
    if (String(path).replace(/^\$\.?/, "") === resultPath) return slotName;
  }
  return null;
}

// Every dispatch tool that needs a contract id names the argument "contractId"
// (confirmed against get_active_transports' and lookup_addresses' declared
// input schemas), but create_transport's OWN arguments don't reference it
// (it uses a static contractNameOrID literal instead) - so there's no
// {{slots.x}} template on the submit binding itself to read this from.
// Reuse whichever slot a SIBLING binding on this workflow already
// references for "contractId", rather than hardcoding a literal slot name
// this specific workflow happens to use (Codex review, PR #1396, P2).
function findSlotRefForArgument(bindings, argKey) {
  for (const binding of bindings) {
    const template = binding?.arguments?.[argKey];
    if (typeof template !== "string") continue;
    const match = template.match(/^\{\{\s*slots\.([^}\s]+)\s*\}\}$/);
    if (match) return match[1];
  }
  return null;
}

// Best-effort surfacing of a timing field whose name we don't know yet.
// Scans for any key containing "eta"/"arrival"/"estimate" and returns its
// value. This response goes directly to the requesting agent's own browser
// (not to a shared log sink), and the agent is already authorized to see
// this trip's own data - unlike the shape-only diagnostic log below, real
// values here are appropriate, the same way mcp-submit's response already
// returns real slotsFilled/invocation data to the caller.
function findTimingFields(entry, prefix = "", depth = 0, found = {}) {
  if (!entry || typeof entry !== "object" || depth > 4) return found;
  for (const [key, value] of Object.entries(entry)) {
    if (/eta|arrival|estimate/i.test(key) && (typeof value === "string" || typeof value === "number")) {
      found[`${prefix}${key}`] = value;
    }
    if (value && typeof value === "object") findTimingFields(value, `${prefix}${key}.`, depth + 1, found);
  }
  return found;
}

/**
 * On-demand transport status/ETA lookup for an already-submitted transport.
 *
 * get_active_transports' output schema was never discovered/cached (same gap
 * create_transport had - see mcp-submit/route.js), so this can't map a known
 * ETA field into a slot yet. Logs the matched entry's SHAPE (never values)
 * so the real field can be identified from a live call, while returning the
 * real matched entry directly to the requesting agent - see findTimingFields.
 */
async function POST_handler(request) {
  try {
    const authSession = await getServerSession(authOptions);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ error: "Database not configured" }, { status: 503 });
    }

    const body = await request.json();
    const sessionId = String(body?.sessionId || "").trim();
    const interactionId = body?.interactionId ? String(body.interactionId) : null;

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const { rows: [workflowSession] } = await pool.query(
      `SELECT s.id, s.workflow_id, s.work_item_id, s.slots_filled, i.agent_username
         FROM aa_workflow_sessions s
         JOIN acd_history_interactions i ON i.id = s.work_item_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!workflowSession) {
      return NextResponse.json({ error: "Workflow session not found" }, { status: 404 });
    }

    const roles = authSession.user.roles || [];
    const currentUsername = await getUsernameForUserId(pool, authSession.user.id);
    // Same fail-closed identity check as mcp-submit/route.js (Codex review on
    // #1372/#1373) - an unresolved identity must be denied, not treated as a
    // pass just because the candidate list came back empty.
    const candidateUsernames = [authSession.user.username, currentUsername].filter(Boolean);
    if (
      (candidateUsernames.length === 0 ||
        !interactionAgentMatches({ agent_username: workflowSession.agent_username }, candidateUsernames)) &&
      !hasPrivilegedRole(roles)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (interactionId && String(workflowSession.work_item_id) !== interactionId) {
      return NextResponse.json({ error: "Workflow session does not belong to this interaction" }, { status: 409 });
    }

    // Codex review (PR #1396, P1): aa_workflow_items has no workflow_id
    // column (only stage_id) - must join through aa_workflow_stages like
    // every other workflow-item query in this codebase, or this raises an
    // undefined-column error on every request.
    const { rows: workflowBindingRows } = await pool.query(
      `SELECT i.mcp_binding
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON s.id = i.stage_id
        WHERE s.workflow_id = $1 AND i.mcp_binding IS NOT NULL`,
      [workflowSession.workflow_id],
    );
    const workflowBindings = workflowBindingRows
      .map((row) => normalizeSlotMcpBinding(row.mcp_binding))
      .filter(Boolean);
    const submitBinding = workflowBindings.find((binding) => binding.tool_name === "create_transport") || null;
    if (!submitBinding?.server_id) {
      return NextResponse.json(
        { error: "No transport MCP server is configured for this workflow" },
        { status: 404 },
      );
    }

    const slotsFilled = workflowSession.slots_filled || {};

    const tripIdSlotName = findOutputSlotName(submitBinding, "olos_trip_id") || "olos_trip_id";
    const tripId = slotsFilled[tripIdSlotName];
    if (!tripId) {
      return NextResponse.json(
        { error: "No transport has been submitted for this session yet" },
        { status: 409 },
      );
    }

    const contractSlotName = findSlotRefForArgument(workflowBindings, "contractId") || "contract_id_numeric";
    const contractId = slotsFilled[contractSlotName];
    if (!contractId) {
      return NextResponse.json(
        { error: "Missing contract information for this session" },
        { status: 409 },
      );
    }

    const response = await callMcpTool({
      serverId: submitBinding.server_id,
      toolName: "get_active_transports",
      input: { ...DEFAULT_TOOL_ARGUMENTS, contractId },
    });
    const { payload, error } = unwrapToolPayload(response);
    if (error) {
      workflowLogger.error("transport_status_check_failed", agentAssistRuntimePayload({
        sessionId,
        interactionId: workflowSession.work_item_id,
        reason: error,
      }));
      return NextResponse.json({ error }, { status: 502 });
    }

    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.result)
        ? payload.result
        : [];
    const match = findTripInList(list, tripId);

    // Temporary diagnostic, same policy as mcp-submit's create_transport
    // logging: SHAPE only (field names + value types), never real values -
    // this list can plausibly carry patient/location details, and once
    // serialized into a single string, agentAssistRuntimePayload's own
    // key-based redaction can no longer inspect it. Remove once the real
    // ETA field is confirmed and this route maps it deterministically
    // instead of the findTimingFields() heuristic below.
    workflowLogger.info("transport_status_check_result_shape", agentAssistRuntimePayload({
      sessionId,
      interactionId: workflowSession.work_item_id,
      tripId: String(tripId),
      listLength: list.length,
      matchFound: !!match,
      resultShape: JSON.stringify(describeShape(match || list[0] || null)),
    }));

    if (!match) {
      return NextResponse.json({
        ok: true,
        found: false,
        listLength: list.length,
        message: "This transport wasn't found in the active transports list yet - it may not have a crew assigned, or status hasn't updated.",
      });
    }

    return NextResponse.json({
      ok: true,
      found: true,
      status: match.status ?? match.tripStatus ?? null,
      etaCandidates: findTimingFields(match),
      trip: match,
    });
  } catch (error) {
    workflowLogger.error("transport_status_check_failed", agentAssistRuntimePayload({
      error,
      reason: error?.message || "transport status check failed",
    }));
    return NextResponse.json(
      { error: error?.message || "Failed to check transport status" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/agent-assist/workflow/transport-status" });
