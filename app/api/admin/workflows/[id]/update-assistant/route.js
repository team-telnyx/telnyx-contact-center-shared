/**
 * Update AI Assistant - Sync assistant instructions with current workflow
 * POST /api/admin/workflows/[id]/update-assistant
 * 
 * Supports step-by-step updates via ?step= query parameter:
 * - step=instructions: Update assistant instructions only
 * - step=insights: Sync insight templates
 * - step=group: Update insight group assignment on assistant
 * 
 * Without step parameter, updates everything at once (legacy mode).
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

/**
 * Load workflow with stages and items
 */
async function loadWorkflowWithStages(pool, workflowId) {
  const { rows: [workflow] } = await pool.query(
    `SELECT id, name, description, ai_assistant_id, insight_group_id, 
            insight_slots_id, insight_summary_id, insight_sentiment_id
     FROM aa_workflows WHERE id = $1`,
    [workflowId]
  );

  if (!workflow) return null;

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

  return { workflow, stages: stagesWithItems, items };
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
    const { searchParams } = new URL(request.url);
    const step = searchParams.get("step");

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const data = await loadWorkflowWithStages(pool, workflowId);
    if (!data) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const { workflow, stages, items } = data;

    if (!workflow.ai_assistant_id) {
      return NextResponse.json(
        { error: "No AI assistant assigned to this workflow" },
        { status: 400 }
      );
    }

    // Step-by-step mode
    if (step) {
      return handleStepUpdate(step, workflow, stages, items, workflowId, apiKey, pool);
    }

    // Legacy mode: update everything at once
    return handleFullUpdate(workflow, stages, items, workflowId, apiKey, pool);

  } catch (err) {
    console.error(`${LOG_PREFIX} Error:`, err);
    return NextResponse.json(
      { error: err?.message || "Failed to update assistant" },
      { status: 500 }
    );
  }
}

/**
 * Handle step-by-step update
 */
async function handleStepUpdate(step, workflow, stages, items, workflowId, apiKey, pool) {
  switch (step) {
    case "instructions":
      return updateInstructionsStep(workflow, stages, apiKey);
    case "insights":
      return syncInsightsStep(workflow, stages, items, workflowId, pool);
    case "group":
      return updateGroupAssignmentStep(workflow, workflowId, apiKey, pool);
    default:
      return NextResponse.json({ error: `Invalid step: ${step}` }, { status: 400 });
  }
}

/**
 * Generate greeting message based on workflow name
 */
function extractQuotedOpening(text) {
  const match = String(text || "").match(/["“]([^"”]+)["”]/);
  return match?.[1]?.trim() || null;
}

function findWorkflowOpening(stages = []) {
  const firstStage = [...stages].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))[0];
  const firstItem = firstStage?.items?.[0];
  if (!firstItem) return null;

  const promptOpening = extractQuotedOpening(firstItem.prompt_hint);
  if (promptOpening) return promptOpening;

  const hintOpening = (Array.isArray(firstItem.hints) ? firstItem.hints : [])
    .map((hint) => extractQuotedOpening(hint))
    .find(Boolean);
  if (hintOpening) return hintOpening;

  const label = firstItem.label || "";
  const identity = label.match(/introduce (?:yourself|your self)(?: as)?\s+(.+?)$/i)?.[1]?.trim();
  if (identity) {
    return `Hello! I'm ${identity}. How may I help you today?`;
  }

  return null;
}

function generateGreeting(workflowName, stages = []) {
  const workflowOpening = findWorkflowOpening(stages);
  if (workflowOpening) return workflowOpening;

  const title = workflowName || "AI Assistant";
  return `Hello! I'm your AI assistant for ${title}. How may I help you today?`;
}

/**
 * Step 1: Update assistant instructions and greeting
 */
async function updateInstructionsStep(workflow, stages, apiKey) {
  console.log(`${LOG_PREFIX} Updating instructions for: ${workflow.name}`);

  const instructions = generateWorkflowInstructions(workflow, stages);
  const greeting = generateGreeting(workflow.name, stages);

  const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instructions, greeting }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: res.status === 404 ? "AI assistant not found on Telnyx" : `Telnyx error: ${res.status}` },
      { status: res.status === 404 ? 404 : 502 }
    );
  }

  console.log(`${LOG_PREFIX} Instructions updated successfully`);
  return NextResponse.json({ ok: true, message: "Instructions updated" });
}

/**
 * Step 2: Sync insight templates
 */
async function syncInsightsStep(workflow, stages, items, workflowId, pool) {
  const hasSlots = items.some((item) => item.type === "slot" && item.slot_name);
  const webhookUrl = getInsightsWebhookUrl();

  if (!hasSlots) {
    return NextResponse.json({ ok: true, skipped: true, message: "No slots to sync" });
  }

  if (!webhookUrl) {
    return NextResponse.json({ ok: true, skipped: true, message: "Webhook URL not configured" });
  }

  console.log(`${LOG_PREFIX} Syncing insights for: ${workflow.name}`);

  try {
    const workflowWithStages = { ...workflow, stages };
    const insightResult = await syncWorkflowInsights(workflowWithStages, webhookUrl);

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

    console.log(`${LOG_PREFIX} Insights synced successfully`);
    return NextResponse.json({ 
      ok: true, 
      message: "Insights synced",
      insightGroupId: insightResult.groupId,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to sync insights:`, err);
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}

/**
 * Step 3: Update insight group assignment on assistant
 */
async function updateGroupAssignmentStep(workflow, workflowId, apiKey, pool) {
  // Re-fetch workflow to get latest insight_group_id (may have been updated in previous step)
  const { rows: [currentWorkflow] } = await pool.query(
    `SELECT insight_group_id FROM aa_workflows WHERE id = $1`,
    [workflowId]
  );

  const insightGroupId = currentWorkflow?.insight_group_id || workflow.insight_group_id;

  if (!insightGroupId) {
    return NextResponse.json({ ok: true, skipped: true, message: "No insight group to assign" });
  }

  console.log(`${LOG_PREFIX} Updating insight group assignment: ${insightGroupId}`);

  const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      insight_settings: { insight_group_id: insightGroupId },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Telnyx error: ${res.status}` },
      { status: 502 }
    );
  }

  console.log(`${LOG_PREFIX} Insight group assignment updated`);
  return NextResponse.json({ ok: true, message: "Insight group assigned" });
}

/**
 * Legacy mode: Update everything at once
 */
async function handleFullUpdate(workflow, stages, items, workflowId, apiKey, pool) {
  const instructions = generateWorkflowInstructions(workflow, stages);
  const greeting = generateGreeting(workflow.name, stages);

  let insightGroupId = workflow.insight_group_id;
  let insightsSynced = false;
  const hasSlots = items.some((item) => item.type === "slot" && item.slot_name);
  const webhookUrl = getInsightsWebhookUrl();

  if (hasSlots && webhookUrl) {
    try {
      const workflowWithStages = { ...workflow, stages };
      const insightResult = await syncWorkflowInsights(workflowWithStages, webhookUrl);
      insightGroupId = insightResult.groupId;

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
    } catch (syncErr) {
      console.warn(`${LOG_PREFIX} Warning: Failed to sync insights:`, syncErr.message);
    }
  }

  const assistantPayload = { instructions, greeting };
  if (insightGroupId) {
    assistantPayload.insight_settings = { insight_group_id: insightGroupId };
  }

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
      { error: res.status === 404 ? "AI assistant not found" : `Telnyx error: ${res.status}` },
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
}
