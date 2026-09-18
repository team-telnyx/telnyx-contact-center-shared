import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, describeShape, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { runAndPersistSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-execute";
import { BINDING_TRIGGERS, normalizeSlotMcpBinding } from "@/lib/agent-assist/slot-mcp-runner.mjs";
import { interactionAgentMatches } from "@/lib/contact-center/interaction-agent-access.mjs";
import { withPermission } from "@/lib/authz/guard";

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

// authSession.user.username is derived from the JWT's token.email, captured
// at login — a username rename or email-fallback login after that can leave
// it stale relative to Core assignment. A fresh by-id lookup
// is the second candidate identity, same pattern as the wrapup/metrics routes.
async function getUsernameForUserId(pool, userId) {
  if (!pool || !userId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT username FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return row?.username || null;
}

/**
 * Explicit, agent-confirmed MCP submission for a new transport request.
 *
 * New configurations use `manual_submit`. `create_transport` bindings saved as
 * `on_complete` by earlier revisions of this PR are accepted here too; the
 * orchestrator suppresses those legacy bindings during normal automatic passes.
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
    const itemId = String(body?.itemId || "").trim();
    const interactionId = body?.interactionId ? String(body.interactionId) : null;

    if (!sessionId || !itemId) {
      return NextResponse.json({ error: "sessionId and itemId are required" }, { status: 400 });
    }

    const { rows: [workflowSession] } = await pool.query(
      `SELECT s.id, s.workflow_id, s.work_item_id, i.agent_username
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
    // interactionAgentMatches treats an empty candidate list as a match (the
    // wrapup routes it was built for use that to skip the check when identity
    // couldn't be derived at all). This caller must NOT inherit that: an
    // authenticated session with no users-table identity (e.g. an OAuth login
    // never provisioned in `users`) must be denied, not treated as a pass
    // (Codex review on #1372/#1373 — fail closed, not open, on unresolved identity).
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

    const { rows: [item] } = await pool.query(
      `SELECT i.id, i.label, i.slot_name, i.mcp_binding
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON s.id = i.stage_id
        WHERE s.workflow_id = $1
          AND i.id = $2
          AND i.mcp_binding IS NOT NULL`,
      [workflowSession.workflow_id, itemId],
    );
    const binding = normalizeSlotMcpBinding(item?.mcp_binding);
    if (!item || !binding) {
      return NextResponse.json({ error: "Manual MCP submit binding not found" }, { status: 404 });
    }
    if (binding.tool_name !== "create_transport") {
      return NextResponse.json(
        { error: "Manual submit is currently restricted to new transport requests" },
        { status: 409 },
      );
    }
    if (![BINDING_TRIGGERS.MANUAL_SUBMIT, BINDING_TRIGGERS.ON_COMPLETE].includes(binding.trigger)) {
      return NextResponse.json({ error: "This create_transport binding is not configured as a completion submit" }, { status: 409 });
    }

    const result = await runAndPersistSlotMcpBindings({
      sessionId,
      workflowId: workflowSession.workflow_id,
      interactionId: workflowSession.work_item_id,
      manualSubmitItemId: itemId,
    });

    const invocation = result.invocations.find((entry) => entry.item_id === itemId) || null;
    if (!invocation) {
      return NextResponse.json(
        {
          error: "Transport is not ready to submit, or it has already been submitted for this session.",
          slotsFilled: result.slotsFilled,
        },
        { status: 409 },
      );
    }
    if (!invocation.ok) {
      return NextResponse.json(
        {
          error: invocation.error || "Transport submission failed",
          invocation,
          slotsFilled: result.slotsFilled,
          itemUpdates: result.itemUpdates,
          completionPercentage: result.completionPercentage,
        },
        { status: 502 },
      );
    }

    workflowLogger.info("transport_mcp_manual_submit_completed", agentAssistRuntimePayload({
      sessionId,
      interactionId: workflowSession.work_item_id,
      workflowId: workflowSession.workflow_id,
      itemId,
      toolName: binding.tool_name,
      status: "ok",
    }));

    // Temporary diagnostic: create_transport's outputs mapping only captures
    // olos_trip_id today (see aa_workflow_items.mcp_binding on this item) -
    // no ETA field, because the tool's raw response shape has never been
    // logged anywhere. Logs only the response's KEY STRUCTURE (field names
    // and value types, never the actual values) so the correct field path
    // for ETA can be identified without exposing patient/trip data through
    // this log sink - the create_transport response can plausibly echo back
    // request fields (patient name, DOB, diagnosis), and this route's own
    // agentAssistRuntimePayload/sanitizeLogPayload redaction only inspects
    // object keys, not the contents of an already-serialized string (Codex
    // review on PR #1393, P1). Remove once outputs is updated to map ETA.
    if (binding.tool_name === "create_transport") {
      const rawResult = result.mcpResults?.[binding.result_key];
      workflowLogger.info("transport_mcp_create_transport_raw_result", agentAssistRuntimePayload({
        sessionId,
        interactionId: workflowSession.work_item_id,
        itemId,
        resultKey: binding.result_key,
        resultShape: JSON.stringify(describeShape(rawResult)),
      }));
    }

    return NextResponse.json({
      ok: true,
      submitted: true,
      itemId,
      invocation,
      slotsFilled: result.slotsFilled,
      slotsFilledAuthoritative: result.slotsFilled !== null,
      itemUpdates: result.itemUpdates,
      completionPercentage: result.completionPercentage,
    });
  } catch (error) {
    workflowLogger.error("transport_mcp_manual_submit_failed", agentAssistRuntimePayload({
      error,
      reason: error?.message || "manual transport submit failed",
    }));
    return NextResponse.json(
      { error: error?.message || "Failed to submit transport" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/agent-assist/workflow/mcp-submit" });
