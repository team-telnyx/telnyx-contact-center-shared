/**
 * Workflow Test - Generate Dynamic Response
 * POST - Generate a simulated customer response based on conversation context
 * 
 * Instead of pre-generating entire test scenarios, this generates responses
 * on-the-fly based on what the AI assistant actually says. This is more
 * robust to changes in AI assistant instructions.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/** Customer persona definitions */
const PERSONAS = {
  cooperative: {
    id: "cooperative",
    name: "Cooperative Customer",
    instruction: `You are a cooperative, friendly customer who answers questions directly and provides requested information promptly. You're patient and helpful.`,
  },
  frustrated: {
    id: "frustrated",
    name: "Frustrated Customer", 
    instruction: `You are a frustrated customer who is annoyed but still trying to complete the process. Express mild frustration, sigh, mention you're in a hurry, but ultimately provide the information requested. Don't be rude, just impatient.`,
  },
  confused: {
    id: "confused",
    name: "Confused Customer",
    instruction: `You are a confused customer who sometimes misunderstands questions or gives incomplete answers. Ask for clarification occasionally. Eventually provide the right information after some back-and-forth.`,
  },
  wants_transfer: {
    id: "wants_transfer",
    name: "Wants Human Agent",
    instruction: `You are a customer who prefers talking to a human. After 2-3 exchanges, start asking to speak with a real person or agent. Be polite but insistent about wanting a human.`,
  },
  verbose: {
    id: "verbose",
    name: "Verbose Customer",
    instruction: `You are a talkative customer who provides more information than asked. Add context, explain your situation, mention related details. Still answer the actual question but with extra commentary.`,
  },
};

/**
 * Generate fake customer data for consistent responses throughout a test session
 */
function generateCustomerData(workflowCategory) {
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
 * Build the prompt for generating a customer response
 */
function buildResponsePrompt(params) {
  const {
    conversationHistory,
    lastAiMessage,
    workflow,
    pendingItems,
    filledSlots,
    customerData,
    persona,
    isFirstResponse,
  } = params;

  const personaInstruction = PERSONAS[persona]?.instruction || PERSONAS.cooperative.instruction;
  
  // Build slot context - what info we need to provide
  const slotContext = pendingItems.length > 0
    ? `Information still needed: ${pendingItems.map(i => `${i.label} (${i.slot_name || 'general'})`).join(", ")}`
    : "All required information has been provided.";

  // Build customer data reference
  const dataRef = Object.entries(customerData)
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  const systemPrompt = `You are simulating a customer in a phone/chat conversation with an AI assistant.
${personaInstruction}

## Your Character Data (use these EXACT values when asked):
${dataRef}

## Workflow Context
This is a "${workflow.name}" workflow.
${slotContext}

## Rules
1. Respond ONLY as the customer - never break character
2. Keep responses concise (1-3 sentences typically)
3. Use the exact data values provided above when answering questions
4. Match the tone/complexity to what a real customer would say
5. If the AI greets you, respond naturally (greeting back, stating your need)
6. If asked for information, provide it using your character data
7. Don't volunteer all information at once - respond to what's being asked
8. Output ONLY the customer's spoken response - no quotes, no "Customer:", no stage directions`;

  let conversationContext = "";
  if (conversationHistory?.length > 0) {
    const recentMessages = conversationHistory.slice(-10); // Last 10 messages for context
    conversationContext = recentMessages
      .map(m => `${m.role === "assistant" ? "AI Assistant" : "Customer"}: ${m.content}`)
      .join("\n");
  }

  const userPrompt = isFirstResponse
    ? `The AI assistant just greeted you. Respond naturally - greet back and/or state why you're calling.

AI Assistant's greeting:
"${lastAiMessage}"

Your response as the customer:`
    : `Continue the conversation. The AI assistant just said:
"${lastAiMessage}"

${conversationContext ? `Recent conversation:\n${conversationContext}\n\n` : ""}Your response as the customer:`;

  return { systemPrompt, userPrompt };
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
      persona = "cooperative",
      customerData: providedCustomerData,
      filledSlots = {},
      model,
    } = body;

    if (!lastAiMessage?.trim()) {
      return NextResponse.json(
        { error: "lastAiMessage is required" },
        { status: 400 }
      );
    }

    // Fetch workflow
    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, category, llm_model FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Fetch workflow items to understand what data is needed
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

    // Determine pending items (not yet filled)
    const filledSlotNames = new Set(Object.keys(filledSlots));
    const pendingItems = items.filter(item => 
      item.slot_name && !filledSlotNames.has(item.slot_name)
    );

    // Use provided customer data or generate new
    const customerData = providedCustomerData || generateCustomerData(workflow.category);
    const isFirstResponse = conversationHistory.length === 0;

    // Build prompt
    const { systemPrompt, userPrompt } = buildResponsePrompt({
      conversationHistory,
      lastAiMessage,
      workflow,
      pendingItems,
      filledSlots,
      customerData,
      persona,
      isFirstResponse,
    });

    // Call LLM
    const llmModel = model || workflow.llm_model || "moonshotai/Kimi-K2.5";
    
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 200,
        temperature: 0.8, // Some variability for natural responses
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Generate Response] LLM error:", errorText);
      throw new Error(`LLM request failed: ${response.status}`);
    }

    const data = await response.json();
    const generatedResponse = data.choices?.[0]?.message?.content?.trim();

    if (!generatedResponse) {
      throw new Error("No response generated from LLM");
    }

    return NextResponse.json({
      ok: true,
      response: generatedResponse,
      customerData, // Return so it can be reused in subsequent calls
      persona,
      pendingItems: pendingItems.map(i => ({ label: i.label, slot_name: i.slot_name })),
    });
  } catch (error) {
    console.error("[Generate Response] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate response" },
      { status: 500 }
    );
  }
}

// GET /api/admin/workflows/[id]/generate-response - Get available personas
export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      ok: true,
      personas: Object.values(PERSONAS),
    });
  } catch (error) {
    console.error("[Generate Response] GET error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get personas" },
      { status: 500 }
    );
  }
}
