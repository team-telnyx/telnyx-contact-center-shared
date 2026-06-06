export const dynamic = "force-dynamic";

/**
 * Delete AI Assistant and associated Insights
 * DELETE /api/admin/workflows/[id]/delete-assistant
 * 
 * Supports step-by-step deletion via ?step= query parameter:
 * - step=assistant: Delete AI Assistant from Telnyx
 * - step=insights: Delete Insight Templates
 * - step=group: Delete Insight Group
 * - step=cleanup: Clear workflow references in database
 * 
 * Without step parameter, deletes everything at once (legacy mode).
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { 
  deleteInsight, 
  deleteInsightGroup,
  unassignInsightFromGroup 
} from "@/lib/telnyx-insights";

const LOG_PREFIX = "[Delete Assistant]";

/**
 * Get assistant details including telephony settings
 */
async function getAssistantDetails(assistantId, apiKey) {
  const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${assistantId}`), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Failed to fetch assistant: ${res.status}`);
  }

  const data = await res.json();
  return data;
}

/**
 * Find phone numbers assigned to a TeXML app (connection)
 */
async function findPhoneNumbersByConnection(connectionId, apiKey) {
  const res = await fetch(buildTelnyxV2Url("/phone_numbers?page[size]=250"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`${LOG_PREFIX} Failed to fetch phone numbers: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const numbers = data?.data || [];
  
  return numbers.filter((n) => n.connection_id === connectionId);
}

/**
 * Unassign phone number from its connection
 */
async function unassignPhoneNumber(phoneNumberId, apiKey) {
  const res = await fetch(buildTelnyxV2Url(`/phone_numbers/${phoneNumberId}`), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connection_id: null }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`${LOG_PREFIX} Failed to unassign phone number ${phoneNumberId}:`, text);
    return false;
  }

  return true;
}

export async function DELETE(request, { params }) {
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

    // Get workflow with all insight IDs
    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, ai_assistant_id, insight_group_id, 
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

    // Step-by-step deletion mode
    if (step) {
      return handleStepDeletion(step, workflow, workflowId, apiKey, pool);
    }

    // Legacy mode: delete everything at once
    return handleFullDeletion(workflow, workflowId, apiKey, pool);

  } catch (err) {
    console.error(`${LOG_PREFIX} Error:`, err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete assistant" },
      { status: 500 }
    );
  }
}

/**
 * Handle step-by-step deletion
 */
async function handleStepDeletion(step, workflow, workflowId, apiKey, pool) {
  switch (step) {
    case "assistant":
      return deleteAssistantStep(workflow, apiKey);
    case "insights":
      return deleteInsightsStep(workflow);
    case "group":
      return deleteGroupStep(workflow);
    case "cleanup":
      return cleanupStep(workflowId, pool);
    default:
      return NextResponse.json(
        { error: `Invalid step: ${step}` },
        { status: 400 }
      );
  }
}

/**
 * Step 1: Delete AI Assistant from Telnyx
 * First unassigns any phone numbers, then deletes the assistant
 */
async function deleteAssistantStep(workflow, apiKey) {
  if (!workflow.ai_assistant_id) {
    return NextResponse.json({ ok: true, skipped: true, message: "No assistant to delete" });
  }

  console.log(`${LOG_PREFIX} Deleting AI assistant: ${workflow.ai_assistant_id}`);
  
  // Get assistant details to find TeXML app ID
  const assistantData = await getAssistantDetails(workflow.ai_assistant_id, apiKey);
  
  if (assistantData) {
    const texmlAppId = assistantData.telephony_settings?.default_texml_app_id;
    
    if (texmlAppId) {
      console.log(`${LOG_PREFIX} Checking for phone numbers on TeXML app: ${texmlAppId}`);
      
      // Find phone numbers assigned to this TeXML app
      const assignedNumbers = await findPhoneNumbersByConnection(texmlAppId, apiKey);
      
      if (assignedNumbers.length > 0) {
        console.log(`${LOG_PREFIX} Unassigning ${assignedNumbers.length} phone number(s)`);
        
        for (const num of assignedNumbers) {
          console.log(`${LOG_PREFIX} Unassigning ${num.phone_number} (${num.id})`);
          await unassignPhoneNumber(num.id, apiKey);
        }
      }
    }
  }

  // Now delete the assistant
  const res = await fetch(
    buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`),
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    }
  );

  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    console.error(`${LOG_PREFIX} Failed to delete assistant:`, text);
    return NextResponse.json(
      { error: `Telnyx API error: ${res.status}` },
      { status: 502 }
    );
  }

  console.log(`${LOG_PREFIX} AI assistant deleted successfully`);
  return NextResponse.json({ ok: true, message: "AI assistant deleted" });
}

/**
 * Step 2: Delete Insight Templates
 */
async function deleteInsightsStep(workflow) {
  const insightIds = [
    workflow.insight_slots_id,
    workflow.insight_summary_id,
    workflow.insight_sentiment_id,
  ].filter(Boolean);

  if (insightIds.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, message: "No insight templates to delete" });
  }

  console.log(`${LOG_PREFIX} Deleting ${insightIds.length} insight templates`);
  
  const errors = [];
  
  for (const insightId of insightIds) {
    try {
      // Unassign from group first if group exists
      if (workflow.insight_group_id) {
        try {
          await unassignInsightFromGroup(insightId, workflow.insight_group_id);
        } catch (e) {
          // Ignore unassign errors
        }
      }
      await deleteInsight(insightId);
    } catch (err) {
      if (err.status !== 404) {
        errors.push(`${insightId}: ${err.message}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`${LOG_PREFIX} Some insight deletions failed:`, errors);
    return NextResponse.json(
      { error: errors.join("; ") },
      { status: 502 }
    );
  }

  console.log(`${LOG_PREFIX} Insight templates deleted successfully`);
  return NextResponse.json({ ok: true, message: "Insight templates deleted" });
}

/**
 * Step 3: Delete Insight Group
 */
async function deleteGroupStep(workflow) {
  if (!workflow.insight_group_id) {
    return NextResponse.json({ ok: true, skipped: true, message: "No insight group to delete" });
  }

  console.log(`${LOG_PREFIX} Deleting insight group: ${workflow.insight_group_id}`);
  
  try {
    await deleteInsightGroup(workflow.insight_group_id);
  } catch (err) {
    if (err.status !== 404) {
      console.error(`${LOG_PREFIX} Failed to delete insight group:`, err);
      return NextResponse.json(
        { error: err.message },
        { status: 502 }
      );
    }
  }

  console.log(`${LOG_PREFIX} Insight group deleted successfully`);
  return NextResponse.json({ ok: true, message: "Insight group deleted" });
}

/**
 * Step 4: Clear workflow references in database
 */
async function cleanupStep(workflowId, pool) {
  console.log(`${LOG_PREFIX} Clearing workflow references`);
  
  await pool.query(
    `UPDATE aa_workflows SET
      ai_assistant_id = NULL,
      insight_group_id = NULL,
      insight_slots_id = NULL,
      insight_summary_id = NULL,
      insight_sentiment_id = NULL,
      updated_at = NOW()
     WHERE id = $1`,
    [workflowId]
  );

  console.log(`${LOG_PREFIX} Workflow references cleared`);
  return NextResponse.json({ ok: true, message: "Workflow references cleared" });
}

/**
 * Legacy mode: Delete everything at once
 */
async function handleFullDeletion(workflow, workflowId, apiKey, pool) {
  if (!workflow.ai_assistant_id) {
    return NextResponse.json(
      { error: "No AI assistant assigned to this workflow" },
      { status: 400 }
    );
  }

  const results = { assistant: null, insights: null, group: null, cleanup: null, phonesUnassigned: 0 };

  // First, unassign phone numbers from assistant's TeXML app
  try {
    const assistantData = await getAssistantDetails(workflow.ai_assistant_id, apiKey);
    
    if (assistantData) {
      const texmlAppId = assistantData.telephony_settings?.default_texml_app_id;
      
      if (texmlAppId) {
        const assignedNumbers = await findPhoneNumbersByConnection(texmlAppId, apiKey);
        
        for (const num of assignedNumbers) {
          console.log(`${LOG_PREFIX} Unassigning ${num.phone_number}`);
          await unassignPhoneNumber(num.id, apiKey);
          results.phonesUnassigned++;
        }
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error unassigning phone numbers:`, err.message);
  }

  // Delete assistant
  try {
    const res = await fetch(
      buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );
    results.assistant = res.ok || res.status === 404 ? "deleted" : "error";
  } catch (err) {
    results.assistant = "error";
  }

  // Delete insights
  const insightIds = [
    workflow.insight_slots_id,
    workflow.insight_summary_id,
    workflow.insight_sentiment_id,
  ].filter(Boolean);
  
  if (insightIds.length > 0) {
    try {
      for (const id of insightIds) {
        if (workflow.insight_group_id) {
          try { await unassignInsightFromGroup(id, workflow.insight_group_id); } catch {}
        }
        await deleteInsight(id);
      }
      results.insights = "deleted";
    } catch {
      results.insights = "error";
    }
  } else {
    results.insights = "skipped";
  }

  // Delete group
  if (workflow.insight_group_id) {
    try {
      await deleteInsightGroup(workflow.insight_group_id);
      results.group = "deleted";
    } catch {
      results.group = "error";
    }
  } else {
    results.group = "skipped";
  }

  // Cleanup
  await pool.query(
    `UPDATE aa_workflows SET
      ai_assistant_id = NULL,
      insight_group_id = NULL,
      insight_slots_id = NULL,
      insight_summary_id = NULL,
      insight_sentiment_id = NULL,
      updated_at = NOW()
     WHERE id = $1`,
    [workflowId]
  );
  results.cleanup = "done";

  return NextResponse.json({ ok: true, results });
}
