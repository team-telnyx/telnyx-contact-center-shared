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

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import {
  WORKFLOW_TESTING_PERSONAS,
  normalizePersona,
  personaInstruction,
  resolveSlotCountForTurn,
  voiceExpressiveKind,
} from "@/lib/call-generator/workflow-testing.mjs";

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

  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

  return {
    caller_name: `${firstName} ${lastName}`,
    first_name: firstName,
    last_name: lastName,
    callback_number: `555-${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
    facility_name: facilities[Math.floor(Math.random() * facilities.length)],
    city: cities[Math.floor(Math.random() * cities.length)],
    date_of_birth: `${Math.floor(Math.random() * 12) + 1}/${Math.floor(Math.random() * 28) + 1}/${Math.floor(Math.random() * 40) + 1960}`,
    account_number: `AC${String(Math.floor(Math.random() * 900000) + 100000)}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@email.com`,
    patient_name: `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`,
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
function buildResponsePrompt(params) {
  const {
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
  } = params;

  const personaText = personaInstruction(persona);
  const slots = Math.max(1, Number(slotCount) || 1);

  // Slot-count instruction — identical discipline to the call-flow tester. With
  // 1 the caller volunteers exactly one piece of information per turn; with >1
  // the caller may answer several requested fields in one natural sentence, but
  // never more than the resolved count and never invents fields the workflow
  // does not need.
  const slotInstruction = slots <= 1
    ? "Provide exactly ONE piece of requested information in this turn (single slot). Do not volunteer additional details the agent has not asked for yet."
    : `You may provide UP TO ${slots} distinct pieces of requested information in a single natural sentence this turn (e.g. customer name, facility name, and date of birth together) to test parallel slot filling. Never provide more than ${slots} distinct pieces of information in this turn, and never invent details the workflow does not need.`;

  const slotContext = pendingItems.length > 0
    ? `Information the agent still needs to collect: ${pendingItems.map((i) => `${i.label}${i.slot_name ? ` (${i.slot_name})` : ""}`).join(", ")}`
    : "All required information has been provided.";

  const dataRef = Object.entries(customerData || {})
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  const systemParts = [
    "You are simulating a realistic caller for automated contact-center workflow testing. Reply as the caller only. Be natural and provide information that helps the agent complete the configured workflow. Do not mention that you are an AI, a test harness, a workflow, or a simulation.",
  ];
  if (personaText) systemParts.push(`Caller persona: ${personaText}`);
  systemParts.push(slotInstruction);
  systemParts.push(`Use these EXACT character data values when the agent asks for the matching detail (do not change them between turns):\n${dataRef}`);

  // Expressive Mode: invite the model to add the voice family's expression tags
  // sparingly for more realistic delivery. Only added when Expressive Mode is on
  // AND the voice family supports it (Ultra SSML emotion tags, or xAI speech
  // tags). Other voices / Mode off → no tag instruction, so TTS never speaks
  // tags literally.
  if (expressiveKind === "ultra") {
    systemParts.push('Expressive Mode is on (Telnyx Ultra voice). You may add SSML emotion tags such as <emotion value="angry" />, <emotion value="excited" />, <emotion value="happy" />, <emotion value="frustrated" /> or <emotion value="hesitant" /> before a sentence, and the nonverbal cue [laughter], to match the persona. Use them sparingly and only when they fit. Output them inline as part of the utterance text.');
  } else if (expressiveKind === "xai") {
    systemParts.push('Expressive Mode is on (xAI Grok voice). You may add xAI speech tags inline to make delivery realistic: [pause], [long-pause], [laugh], [chuckle], [giggle], [sigh], [breath], [inhale], [exhale] placed where the sound happens, and wrapping tags like <soft>...</soft>, <whisper>...</whisper>, <emphasis>...</emphasis>, <slow>...</slow>, <fast>...</fast> to set delivery style. Use them sparingly and only when they fit the persona. Output them inline as part of the utterance text.');
  }

  const task = isFirstResponse
    ? "The AI assistant just greeted you. Generate the caller's opening utterance: greet back and/or briefly state why you are calling. Do not dump personal details yet — wait for the agent to ask."
    : "Generate the next caller utterance in response to the agent's latest message.";

  return [
    { role: "system", content: systemParts.join(" ") },
    {
      role: "user",
      content: JSON.stringify({
        task,
        workflow: {
          name: workflow?.name || "Workflow",
          description: workflow?.description || "",
          items: workflowItems,
        },
        slot_context: slotContext,
        recent_conversation: Array.isArray(conversationHistory)
          ? conversationHistory.slice(-8).map((m) => ({
              role: m.role === "assistant" ? "agent" : "caller",
              text: m.content,
            }))
          : [],
        latest_agent_message: String(lastAiMessage || "").slice(0, 2000),
        persona: normalizePersona(persona),
        max_information_pieces_this_turn: slots,
        style: slots <= 1
          ? "One short spoken sentence. Include a single concrete detail from your character data when the agent asks for it. Example for healthcare intake: patient name John Wick."
          : "One or two short spoken sentences. Include concrete details from your character data when the agent asks for them. Example for healthcare intake: patient name John Wick, date of birth July 4 1978.",
        output: "Return only the caller utterance text, no JSON, no labels, no quotes.",
      }),
    },
  ];
}

// POST /api/admin/workflows/[id]/generate-response
export async function POST(request, { params }) {
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
      `SELECT id, name, description, category, llm_model FROM aa_workflows WHERE id = $1`,
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

    // Call LLM (use the workflow's configured model, like the call-flow tester).
    const llmModel = workflow.llm_model || "openai/gpt-4o";

    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        model: llmModel,
        messages,
        temperature: 0.7,
        max_tokens: 160,
      }),
    });

    if (!response.ok) {
      workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId }) });
      throw new Error(`LLM request failed: ${response.status}`);
    }

    const data = await response.json();
    const generatedResponse =
      (data?.choices?.[0]?.message?.content || data?.data?.choices?.[0]?.message?.content || "")
        .replace(/^['"\s]+|['"\s]+$/g, "")
        .trim();

    if (!generatedResponse) {
      throw new Error("No response generated from LLM");
    }

    return NextResponse.json({
      ok: true,
      response: generatedResponse,
      customerData, // Return so it can be reused in subsequent calls
      persona: normalizePersona(persona),
      slotCount,
      pendingItems,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ error }) });
    return NextResponse.json(
      { error: error.message || "Failed to generate response" },
      { status: 500 }
    );
  }
}

// GET /api/admin/workflows/[id]/generate-response - Get available personas.
// Returns the same persona vocabulary as the Call Generator workflow tester so
// the Test AI Agent page offers an identical persona list.
export async function GET(request, { params }) {
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
