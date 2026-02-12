/**
 * Delete AI Assistant and associated Insights
 * DELETE /api/admin/workflows/[id]/delete-assistant
 * 
 * Deletes:
 * - AI Assistant from Telnyx
 * - Insight Group
 * - Insight Templates (slots, summary, sentiment)
 * - Clears workflow references
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { deleteWorkflowInsights } from "@/lib/telnyx-insights";

const LOG_PREFIX = "[Delete Assistant]";

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

    if (!workflow.ai_assistant_id) {
      return NextResponse.json(
        { error: "No AI assistant assigned to this workflow" },
        { status: 400 }
      );
    }

    const deletionResults = {
      assistant: { deleted: false, error: null },
      insights: { deleted: false, error: null },
      group: { deleted: false, error: null },
    };

    // 1. Delete AI Assistant from Telnyx
    console.log(`${LOG_PREFIX} Deleting AI assistant: ${workflow.ai_assistant_id}`);
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

      if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`Telnyx API error: ${res.status} ${text}`);
      }

      deletionResults.assistant.deleted = true;
      console.log(`${LOG_PREFIX} AI assistant deleted successfully`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to delete assistant:`, err);
      deletionResults.assistant.error = err.message;
    }

    // 2. Delete Insight Templates
    const hasInsightTemplates = workflow.insight_slots_id || 
        workflow.insight_summary_id || workflow.insight_sentiment_id;
    
    if (hasInsightTemplates) {
      console.log(`${LOG_PREFIX} Deleting insight templates for workflow: ${workflow.name}`);
      try {
        // Delete each template individually to track errors
        const templateErrors = [];
        
        if (workflow.insight_slots_id) {
          try {
            await deleteWorkflowInsights({ 
              ...workflow, 
              insight_summary_id: null, 
              insight_sentiment_id: null,
              insight_group_id: null 
            });
          } catch (e) {
            templateErrors.push(`slots: ${e.message}`);
          }
        }
        
        if (workflow.insight_summary_id) {
          try {
            await deleteWorkflowInsights({ 
              ...workflow, 
              insight_slots_id: null, 
              insight_sentiment_id: null,
              insight_group_id: null 
            });
          } catch (e) {
            templateErrors.push(`summary: ${e.message}`);
          }
        }
        
        if (workflow.insight_sentiment_id) {
          try {
            await deleteWorkflowInsights({ 
              ...workflow, 
              insight_slots_id: null, 
              insight_summary_id: null,
              insight_group_id: null 
            });
          } catch (e) {
            templateErrors.push(`sentiment: ${e.message}`);
          }
        }
        
        if (templateErrors.length > 0) {
          throw new Error(templateErrors.join("; "));
        }
        
        deletionResults.insights.deleted = true;
        console.log(`${LOG_PREFIX} Insight templates deleted successfully`);
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to delete insight templates:`, err);
        deletionResults.insights.error = err.message;
        deletionResults.insights.deleted = true; // Mark as attempted
      }
    } else {
      deletionResults.insights.deleted = true; // Nothing to delete
    }

    // 3. Delete Insight Group
    if (workflow.insight_group_id) {
      console.log(`${LOG_PREFIX} Deleting insight group: ${workflow.insight_group_id}`);
      try {
        await deleteWorkflowInsights({ 
          ...workflow, 
          insight_slots_id: null, 
          insight_summary_id: null,
          insight_sentiment_id: null 
        });
        deletionResults.group.deleted = true;
        console.log(`${LOG_PREFIX} Insight group deleted successfully`);
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to delete insight group:`, err);
        deletionResults.group.error = err.message;
      }
    } else {
      deletionResults.group.deleted = true; // Nothing to delete
    }

    // 4. Clear workflow references in database
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

    // Check if any deletions failed
    const hasErrors = deletionResults.assistant.error || 
                      deletionResults.insights.error || 
                      deletionResults.group.error;

    if (hasErrors) {
      console.warn(`${LOG_PREFIX} Completed with some errors:`, deletionResults);
      return NextResponse.json({
        ok: true,
        partial: true,
        message: "AI agent deleted with some errors",
        details: deletionResults,
      });
    }

    console.log(`${LOG_PREFIX} All resources deleted successfully`);
    return NextResponse.json({
      ok: true,
      message: "AI agent and all associated resources deleted successfully",
      details: deletionResults,
    });

  } catch (err) {
    console.error(`${LOG_PREFIX} Error:`, err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete assistant" },
      { status: 500 }
    );
  }
}
