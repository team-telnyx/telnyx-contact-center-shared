/**
 * Update AI Assistant - Sync assistant instructions with current workflow
 * POST /api/admin/workflows/[id]/update-assistant
 * Regenerates instructions from workflow stages and PATCHes the Telnyx assistant.
 * Also syncs insight_settings with the insight group if available.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { generateWorkflowInstructions } from "@/lib/agent-assist/workflow-instructions";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { syncWorkflowInsights } from "@/lib/telnyx-insights";

const LOG_PREFIX = "[Update Assistant]";

/**
 * Get webhook URL for insights from environment
 * @returns {string|null} Webhook URL or null if not configured
 */
function getInsightsWebhookUrl() {
  const baseUrl = process.env.TELNYX_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL;
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/webhooks/telnyx/conversation-insights`;
}

export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const { id: workflowId } = await params;
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Parse request body for options
    let options = {};
    try {
      const body = await request.json();
      options = body || {};
    } catch {
      // Empty body is OK
    }

    const { syncInsights: requestSyncInsights = true } = options;

    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, description, ai_assistant_id, insight_group_id, 
              insight_slots_id, insight_summary_id, insight_sentiment_id
       FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (!workflow.ai_assistant_id) {
      return NextResponse.json(
        { error: "No AI assistant assigned to this workflow" },
        { status: 400 }
      );
    }

    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
    );

    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows: itemRows } = await pool.query(
        `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
        [stageIds]
      );
      items = itemRows;
    }

    const itemsByStage = items.reduce((acc, item) => {
      if (!acc[item.stage_id]) acc[item.stage_id] = [];
      acc[item.stage_id].push(item);
      return acc;
    }, {});

    const stagesWithItems = stages.map((s) => ({
      ...s,
      items: itemsByStage[s.id] || [],
    }));

    // Generate instructions
    const instructions = generateWorkflowInstructions(workflow, stagesWithItems);

    // Check if we need to sync insights
    let insightGroupId = workflow.insight_group_id;
    let insightsSynced = false;
    const hasSlots = items.some((item) => item.type === "slot" && item.slot_name);
    const webhookUrl = getInsightsWebhookUrl();

    // Sync insights if:
    // - requestSyncInsights is true (default)
    // - Workflow has slots
    // - Webhook URL is configured
    // - Either no insight group exists OR we want to ensure it's up to date
    if (requestSyncInsights && hasSlots && webhookUrl) {
      try {
        console.log(`${LOG_PREFIX} Syncing insights for workflow: ${workflow.name}`);
        
        const workflowWithStages = {
          ...workflow,
          stages: stagesWithItems,
        };

        const insightResult = await syncWorkflowInsights(workflowWithStages, webhookUrl);
        insightGroupId = insightResult.groupId;

        // Update workflow with insight IDs
        await pool.query(
          `UPDATE aa_workflows SET
            insight_group_id = $1,
            insight_slots_id = $2,
            insight_summary_id = $3,
            insight_sentiment_id = $4,
            updated_at = NOW()
           WHERE id = $5`,
          [
            insightResult.groupId,
            insightResult.slotsInsightId,
            insightResult.summaryInsightId,
            insightResult.sentimentInsightId,
            workflowId,
          ]
        );

        insightsSynced = true;
        console.log(`${LOG_PREFIX} Insights synced successfully`);
      } catch (syncErr) {
        console.warn(`${LOG_PREFIX} Warning: Failed to sync insights:`, syncErr.message);
        // Continue with assistant update
      }
    }

    // Build assistant update payload
    const assistantPayload = { instructions };

    // Include insight_settings if we have an insight group
    if (insightGroupId) {
      assistantPayload.insight_settings = {
        insight_group_id: insightGroupId,
      };
    }

    // Update the assistant
    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(assistantPayload),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        {
          ok: false,
          error: res.status === 404
            ? "AI assistant not found on Telnyx (may have been deleted)"
            : `Telnyx API error: ${res.status} ${text}`,
        },
        { status: res.status === 404 ? 404 : 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      assistant: data?.data || data,
      insightsSynced,
      insightGroupId,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Error:`, err);
    return NextResponse.json(
      { error: err?.message || "Failed to update assistant" },
      { status: 500 }
    );
  }
}
