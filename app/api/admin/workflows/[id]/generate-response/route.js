import { buildResponsePrompt } from '../../../../../../lib/ai-operations/prompts/web-caller.mjs';
import { prepareAiOperation, resolveOperationModel } from '@/lib/ai-operations/runtime.mjs';
import { resolveTestModel } from '@/lib/agent-assist/test-model-override.mjs';
import { chatCopilotCatalog } from '@/lib/contact-center/chat-copilot';
/**
 * Workflow Test - Generate Dynamic Response
 * POST - Generate a simulated customer response based on conversation context
 *
 * Instead of pre-generating entire test scenarios, this generates responses
 * on-the-fly based on what the AI assistant actually says. This is more
 * robust to changes in AI assistant instructions.
 *
 * Slot-filling quality, persona vocabulary and Expressive Mode are shared with
 * the Call Generator's "Workflow Testing" action (lib/call-generator/workflow-testing.mjs)
 * so that simulated callers in the browser "Test AI Agent" page behave exactly
 * like the simulated callers used for real call-flow workflow testing. This keeps
 * test results consistent with what a real customer conversation will produce.
 */

import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import {
  WORKFLOW_TESTING_PERSONAS,
  SIMULATED_CALLER_MAX_TOKENS,
  normalizePersona,
  personaInstruction,
  resolveSlotCountForTurn,
  voiceExpressiveKind,
} from "@/lib/call-generator/workflow-testing.mjs";

import { withPermission } from "@/lib/authz/guard";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Generate fake customer data for consistent responses throughout a test session.
 * The simulated caller draws on these stable values so that, across turns, the
 * same name / DOB / account number is reused (a real caller does not change
 * their own details mid-call). The LLM is told to use them only when the agent
 * actually asks for the matching field.
 */
function generateCustomerData() {
  const firstNames = ["Sarah", "Michael", "Emily", "James", "Maria", "David", "Jennifer", "Robert", "Lisa", "William"];
  const lastNames = ["Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Wilson"];
  const facilities = ["Mercy General Hospital", "St. Luke's Medical Center", "Cedar Valley Regional", "Riverside Community Hospital", "Mountain View Clinic"];
  const cities = ["Austin", "Denver", "Portland", "Seattle", "Phoenix", "Chicago", "Boston", "Atlanta", "Miami", "Dallas"];

  const firstName = firstNames[randomInt(firstNames.length)];
  const lastName = lastNames[randomInt(lastNames.length)];

  return {
    caller_name: `${firstName} ${lastName}`,
    first_name: firstName,
    last_name: lastName,
    callback_number: `555-${String(randomInt(900) + 100)}-${String(randomInt(9000) + 1000)}`,
    facility_name: facilities[randomInt(facilities.length)],
    city: cities[randomInt(cities.length)],
    date_of_birth: `${randomInt(12) + 1}/${randomInt(28) + 1}/${randomInt(40) + 1960}`,
    account_number: `AC${String(randomInt(900000) + 100000)}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@email.com`,
    patient_name: `${firstNames[randomInt(firstNames.length)]} ${lastNames[randomInt(lastNames.length)]}`,
  };
}

/**
 * Build the simulated-caller prompt. This mirrors buildCustomerReplyPrompt from
 * lib/call-generator/workflow-testing.mjs (the call-flow workflow tester) so the
 * caller's slot-filling behaviour is identical:
 *   - strict slot-count discipline (don't dump every field at once),
 *   - concrete fake-but-plausible details only when the agent asks,
 *   - structured workflow item context (label + description + stage),
 *   - persona role-play and, when Expressive Mode is on, voice-family tags.
 *
 * The only deltas vs the call-flow tester:
 *   - a stable per-session customerData block (so repeated details stay consistent),
 *   - an explicit "pending items still needed" hint derived from filled slots,
 *   - first-turn greeting handling.
 */


// POST /api/admin/workflows/[id]/generate-response
async function POST_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!TELNYX_API_KEY) {
      return NextResponse.json(
        { error: "TELNYX_API_KEY not configured" },
        { status: 503 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const { id: workflowId } = await params;
    const body = await request.json();
    const {
      lastAiMessage,
      conversationHistory = [],
      persona = "neutral",
      customerData: providedCustomerData,
      filledSlots = {},
      voice = "",
      expressive = false,
      maxSlotsPerTurn = 1,
      randomizeSlots = false,
    } = body;

    if (!lastAiMessage?.trim()) {
      return NextResponse.json(
        { error: "lastAiMessage is required" },
        { status: 400 }
      );
    }

    // Fetch workflow
    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, description, category, llm_model, llm_reasoning_enabled FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Fetch workflow items to understand what data is needed.
    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
    );

    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT i.*, s.name as stage_name
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         WHERE i.stage_id = ANY($1) AND i.type != 'action'
         ORDER BY s.order_index, i.order_index`,
        [stageIds]
      );
      items = rows;
    }

    // Compact, ordered item context for the LLM — mirrors compactWorkflowItems
    // in the call-flow tester (title + description + type + stage) so the caller
    // understands the shape of the data the agent will collect.
    const workflowItems = items.slice(0, 30).map((item, index) => ({
      index: index + 1,
      title: item.label || item.slot_name || "Workflow item",
      description: item.description || item.prompt_hint || "",
      type: item.type || null,
      stage: item.stage_name || null,
      slot_name: item.slot_name || null,
    }));

    // Determine pending items (not yet filled).
    const filledSlotNames = new Set(Object.keys(filledSlots));
    const pendingItems = items
      .filter((item) => item.slot_name && !filledSlotNames.has(item.slot_name))
      .map((item) => ({ label: item.label, slot_name: item.slot_name }));

    // Use provided customer data or generate new (stable across the session).
    const customerData = providedCustomerData || generateCustomerData();
    const isFirstResponse = conversationHistory.length === 0;

    // Resolve how many distinct slots the caller may fill this turn, and whether
    // to invite voice expression tags (only when Expressive Mode is on AND the
    // voice family supports it).
    const slotCount = resolveSlotCountForTurn({ maxSlotsPerTurn, randomizeSlots });
    const expressiveKind = expressive === true ? voiceExpressiveKind(voice) : null;

    // Build prompt
    const messages = buildResponsePrompt({
      conversationHistory,
      lastAiMessage,
      workflow,
      pendingItems,
      workflowItems,
      customerData,
      persona,
      isFirstResponse,
      slotCount,
      expressiveKind,
    });

    // Simulated caller model: per-test override (Test AI Agent model picker) >
    // the Admin → AI Copilot "Simulated customer" default > built-in default.
    // The workflow's own model is for slot analysis and intent, not for the
    // simulated customer.
    const override = await resolveTestModel(body.model, { loadCatalog: chatCopilotCatalog });
    const callerModel = await resolveOperationModel("test-caller", { preferredModel: override.model, preferredSource: "test" });
    const llmModel = callerModel.model;

    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify(await prepareAiOperation('test-caller', {
        model: llmModel,
        messages,
        temperature: 0.7,
        max_tokens: SIMULATED_CALLER_MAX_TOKENS,
        enable_thinking: workflow.llm_reasoning_enabled === true,
      }, {preferredModel: llmModel})),
    });

    if (!response.ok) {
      workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId }) });
      // Telnyx explains model problems (for example "requires a
      // customer-provided API key"); name the model so the operator can pick
      // another one in the test or in Admin → AI Copilot.
      const detail = await response.json().then((d) => d?.errors?.[0]?.detail || d?.error?.message || "", () => "");
      throw new Error(`The simulated caller model ${llmModel} failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`);
    }

    const data = await response.json();
    const generatedResponse =
      (data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || "")
        .replace(/^['"\s]+|['"\s]+$/g, "")
        .trim();

    if (!generatedResponse) {
      const finish = data?.choices?.[0]?.finish_reason || data?.data?.choices?.[0]?.finish_reason || "unknown";
      throw new Error(`The simulated caller model ${llmModel} returned no text (finish reason: ${finish}). Choose another caller model or retry.`);
    }

    return NextResponse.json({
      ok: true,
      response: generatedResponse,
      customerData, // Return so it can be reused in subsequent calls
      persona: normalizePersona(persona),
      slotCount,
      pendingItems,
      model: llmModel,
      modelSource: callerModel.source,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ error }) });
    return NextResponse.json(
      { error: error.message || "Failed to generate response" },
      { status: error?.status === 400 ? 400 : 500 }
    );
  }
}

// GET /api/admin/workflows/[id]/generate-response - Get available personas.
// Returns the same persona vocabulary as the Call Generator workflow tester so
// the Test AI Agent page offers an identical persona list.
async function GET_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      ok: true,
      personas: WORKFLOW_TESTING_PERSONAS.map((p) => ({
        id: p.id,
        name: p.label,
        instruction: p.instruction,
      })),
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ error }) });
    return NextResponse.json(
      { error: error.message || "Failed to get personas" },
      { status: 500 }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("workflows:ai", GET_handler, { route: "/api/admin/workflows/[id]/generate-response" });
export const POST = withPermission("workflows:ai", POST_handler, { route: "/api/admin/workflows/[id]/generate-response" });
