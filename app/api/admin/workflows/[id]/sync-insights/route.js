export const dynamic = "force-dynamic";

/**
 * Sync Workflow Insights API
 * POST /api/admin/workflows/[id]/sync-insights
 * 
 * Synchronizes Telnyx Insight Group and Templates with the workflow.
 * Creates or updates insights for slot extraction, call summary, and sentiment analysis.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { syncWorkflowInsights } from "@/lib/telnyx-insights";

const LOG_PREFIX = "[Sync Insights]";

/**
 * Get webhook URL for insights from environment
 * @returns {string} Webhook URL
 */
function getInsightsWebhookUrl() {
  const baseUrl = process.env.TELNYX_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL;
  if (!baseUrl) {
    throw new Error("TELNYX_WEBHOOK_BASE_URL or NEXTAUTH_URL must be configured");
  }
  return `${baseUrl.replace(/\/$/, "")}/api/webhooks/telnyx/conversation-insights`;
}

/**
 * POST /api/admin/workflows/[id]/sync-insights
 * 
 * Sync insights for a workflow with Telnyx.
 * Creates Insight Group and 3 Insight Templates (slots, summary, sentiment).
 */
export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const { force = false } = options;

    // Fetch workflow with stages and items
    const { rows: [workflow] } = await pool.query(
      `SELECT w.*, 
              u.username as created_by_username
       FROM aa_workflows w
       LEFT JOIN users u ON w.created_by = u.id
       WHERE w.id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Check if workflow has AI assistant
    if (!workflow.ai_assistant_id) {
      return NextResponse.json(
        { error: "Workflow does not have an AI assistant. Create an AI assistant first." },
        { status: 400 }
      );
    }

    // Fetch stages with items
    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
    );

    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
        [stageIds]
      );
      items = rows;
    }

    // Attach items to stages
    const itemsByStage = items.reduce((acc, item) => {
      if (!acc[item.stage_id]) acc[item.stage_id] = [];
      acc[item.stage_id].push(item);
      return acc;
    }, {});

    const stagesWithItems = stages.map((stage) => ({
      ...stage,
      items: itemsByStage[stage.id] || [],
    }));

    // Check if workflow has any slots
    const hasSlots = items.some((item) => item.type === "slot" && item.slot_name);
    if (!hasSlots) {
      return NextResponse.json(
        { error: "Workflow has no slot items. Add at least one slot to sync insights." },
        { status: 400 }
      );
    }

    // Build workflow object for sync
    const workflowWithStages = {
      ...workflow,
      stages: stagesWithItems,
    };

    // If force, clear existing insight IDs to force recreation
    if (force) {
      console.log(`${LOG_PREFIX} Force mode - will recreate insights`);
      workflowWithStages.insight_group_id = null;
      workflowWithStages.insight_slots_id = null;
      workflowWithStages.insight_summary_id = null;
      workflowWithStages.insight_sentiment_id = null;
    }

    // Get webhook URL
    const webhookUrl = getInsightsWebhookUrl();
    console.log(`${LOG_PREFIX} Using webhook URL: ${webhookUrl}`);

    // Sync insights with Telnyx
    console.log(`${LOG_PREFIX} Syncing insights for workflow: ${workflow.name}`);
    const result = await syncWorkflowInsights(workflowWithStages, webhookUrl);

    // Update workflow with new insight IDs
    await pool.query(
      `UPDATE aa_workflows SET
        insight_group_id = $1,
        insight_slots_id = $2,
        insight_summary_id = $3,
        insight_sentiment_id = $4,
        updated_at = NOW()
       WHERE id = $5`,
      [
        result.groupId,
        result.slotsInsightId,
        result.summaryInsightId,
        result.sentimentInsightId,
        workflowId,
      ]
    );

    // Update AI assistant with insight_settings if we have a new group
    if (result.groupId && workflow.ai_assistant_id) {
      try {
        await updateAssistantInsightSettings(workflow.ai_assistant_id, result.groupId);
        console.log(`${LOG_PREFIX} Updated assistant ${workflow.ai_assistant_id} with insight group ${result.groupId}`);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Warning: Failed to update assistant insight settings:`, err.message);
        // Continue - insights are still synced
      }
    }

    // Determine action based on what was done
    const action = !workflow.insight_group_id || force
      ? "created"
      : "updated";

    console.log(`${LOG_PREFIX} Sync complete for workflow ${workflow.name}: ${action}`);

    return NextResponse.json({
      ok: true,
      action,
      insight_group_id: result.groupId,
      insight_slots_id: result.slotsInsightId,
      insight_summary_id: result.summaryInsightId,
      insight_sentiment_id: result.sentimentInsightId,
      webhook_url: webhookUrl,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Error:`, error);
    return NextResponse.json(
      { error: error.message || "Failed to sync insights" },
      { status: 500 }
    );
  }
}

/**
 * Update AI assistant with insight_settings
 * @param {string} assistantId - Telnyx AI assistant ID
 * @param {string} insightGroupId - Insight group ID
 */
async function updateAssistantInsightSettings(assistantId, insightGroupId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY not configured");
  }

  const { buildTelnyxV2Url } = await import("@/lib/telnyx");

  const response = await fetch(buildTelnyxV2Url(`/ai/assistants/${assistantId}`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      insight_settings: {
        insight_group_id: insightGroupId,
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update assistant: ${response.status} ${text}`);
  }

  return response.json();
}
