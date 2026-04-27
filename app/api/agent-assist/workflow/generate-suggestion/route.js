/**
 * Agent Assist Workflow - Generate Suggestion API
 * POST - Generate dynamic suggestions using LLM
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// POST /api/agent-assist/workflow/generate-suggestion
export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const {
      itemId,
      itemLabel,
      itemDescription,
      itemType,
      slotOptions,
      workflowId,
      agentName,
      brandName,
      previousConversation,
      isAiAssisted,
      isFirstItem,
      prefilledSlots,
    } = body;

    if (!itemLabel) {
      return NextResponse.json(
        { error: "itemLabel is required" },
        { status: 400 }
      );
    }

    // Get workflow to get LLM model
    let llmModel = "moonshotai/Kimi-K2.5"; // Default
    if (workflowId) {
      const { rows: [workflow] } = await pool.query(
        `SELECT llm_model FROM aa_workflows WHERE id = $1`,
        [workflowId]
      );
      if (workflow?.llm_model) {
        llmModel = workflow.llm_model;
      }
    }

    // Special case: AI-assisted call, first item — generate handoff greeting
    if (isAiAssisted && isFirstItem) {
      const { systemPrompt: hsys, userPrompt: husr } = buildHandoffGreetingPrompt({
        agentName: agentName || null,
        brandName: brandName || null,
        prefilledSlots: prefilledSlots || {},
      });

      const hResponse = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TELNYX_API_KEY}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: hsys },
            { role: "user", content: husr },
          ],
          model: llmModel,
          temperature: 0.7,
          max_tokens: 200,
        }),
      });

      if (hResponse.ok) {
        const hData = await hResponse.json();
        let hSuggestion = hData.choices?.[0]?.message?.content || hData.choices?.[0]?.message?.reasoning || "";
        hSuggestion = hSuggestion.replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        for (let i = 0; i < 3; i++) {
          hSuggestion = hSuggestion.replace(/^["'\u2018\u2019\u201c\u201d\u201e\u00ab\u00bb]|["'\u2018\u2019\u201c\u201d\u201e\u00bb\u00ab]$/g, "").trim();
        }
        if (agentName && agentName !== "the agent") {
          hSuggestion = hSuggestion.replace(/\[Your Name\]/gi, agentName).replace(/\[Agent Name\]/gi, agentName);
        }
        if (hSuggestion) {
          return NextResponse.json({ ok: true, suggestion: hSuggestion, model: llmModel, isHandoffGreeting: true });
        }
      }
      // Fall through to regular suggestion if handoff generation fails
    }

    // Build prompt for suggestion generation
    const systemPrompt = buildSuggestionSystemPrompt({
      itemType,
      agentName,
      brandName,
    });

    const userPrompt = buildSuggestionUserPrompt({
      itemLabel,
      itemDescription,
      slotOptions,
      previousConversation,
    });

    // Call Telnyx AI
    const response = await fetch(`${TELNYX_API_BASE}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        model: llmModel,
        temperature: 0.7,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        "[Generate Suggestion] API error:",
        response.status,
        errorText
      );
      return NextResponse.json(
        { error: "Failed to generate suggestion" },
        { status: response.status }
      );
    }

    const data = await response.json();
    let suggestion = data.choices?.[0]?.message?.content;

    if (!suggestion) {
      return NextResponse.json(
        { error: "No suggestion generated" },
        { status: 500 }
      );
    }

    // Clean up the suggestion - remove quotes, leading/trailing whitespace
    suggestion = suggestion.trim();
    // Remove wrapping quotes (single or double, including fancy quotes) - run multiple times for nested quotes
    for (let i = 0; i < 3; i++) {
      suggestion = suggestion.replace(/^["'"'„"«»]|["'"'"»«]$/g, '').trim();
    }
    // Replace [Your Name] placeholders with actual agent name
    const finalAgentName = agentName && agentName !== "the agent" ? agentName : null;
    if (finalAgentName) {
      suggestion = suggestion.replace(/\[Your Name\]/gi, finalAgentName);
      suggestion = suggestion.replace(/\[Agent Name\]/gi, finalAgentName);
      suggestion = suggestion.replace(/\[Agent's Name\]/gi, finalAgentName);
      suggestion = suggestion.replace(/\[Name\]/gi, finalAgentName);
      suggestion = suggestion.replace(/\{Your Name\}/gi, finalAgentName);
      suggestion = suggestion.replace(/\{Agent Name\}/gi, finalAgentName);
    }

    return NextResponse.json({
      ok: true,
      suggestion: suggestion.trim(),
      model: llmModel,
    });
  } catch (error) {
    console.error("[Generate Suggestion] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate suggestion" },
      { status: 500 }
    );
  }
}

/**
 * Build system prompt for suggestion generation
 */
function buildSuggestionSystemPrompt({ itemType, agentName, brandName }) {
  const agentIdentity = agentName || "an agent";
  const brand = brandName || "the company";

  return `You are an expert contact center assistant helping ${agentIdentity} at ${brand}.
Your task is to generate a helpful script suggestion for the agent to use during a customer call.

## Guidelines:

1. **Write in first person** - The agent will speak these words directly
2. **Be natural and conversational** - Sound like a real person, not a robot
3. **Be concise** - Keep it to 1-3 sentences maximum
4. **Match the item type:**
   - **action**: Suggest what the agent should say while performing the action
   - **question**: Generate a clear question to ask the customer
   - **topic**: Suggest how to introduce or discuss this topic
   - **slot**: Generate a polite question to collect the specific information

5. **Be professional but friendly** - Maintain ${brand}'s tone
6. **Include context when helpful** - Reference previous conversation if relevant

Generate ONLY the suggested script - no explanations, no meta-commentary.`;
}

/**
 * Build user prompt for suggestion generation
 */
function buildSuggestionUserPrompt({
  itemLabel,
  itemDescription,
  slotOptions,
  previousConversation,
}) {
  let prompt = `Generate a script suggestion for this workflow item:

**Item**: ${itemLabel}`;

  if (itemDescription) {
    prompt += `\n**Context**: ${itemDescription}`;
  }

  if (slotOptions && slotOptions.length > 0) {
    prompt += `\n**Options**: Customer should choose from: ${slotOptions.join(", ")}`;
  }

  if (previousConversation && previousConversation.length > 0) {
    const recentMessages = previousConversation.slice(-5);
    prompt += `\n\n**Recent conversation context:**\n`;
    prompt += recentMessages
      .map((msg) => `${msg.speaker}: "${msg.text}"`)
      .join("\n");
  }

  return prompt;
}

/**
 * Build prompts for AI-assisted call handoff greeting
 */
function buildHandoffGreetingPrompt({ agentName, brandName, prefilledSlots }) {
  const agent = agentName && agentName !== "the agent" ? agentName : null;
  const brand = brandName || "the company";
  const filledSlotNames = Object.keys(prefilledSlots || {}).filter(
    (k) => prefilledSlots[k] !== null && prefilledSlots[k] !== undefined && prefilledSlots[k] !== ""
  );

  const slotsContext =
    filledSlotNames.length > 0
      ? `The AI assistant has already collected the following customer information: ${filledSlotNames.map((k) => `${k}: ${prefilledSlots[k]}`).join(", ")}.`
      : "The AI assistant started the conversation but did not collect any specific data yet.";

  const systemPrompt = `You are an expert contact center script writer for ${brand}.
Generate a natural, warm greeting for a human agent who is taking over a call that was started by an AI assistant.
The greeting should:
1. Introduce the agent by name (if known)
2. Acknowledge that the call was handled by an AI assistant first
3. Show awareness of information already collected (briefly, naturally)
4. Ask if the customer wants to continue on the same topic
Keep it to 2-3 sentences maximum. Sound natural and human, not robotic. Write in first person.`;

  const userPrompt = `Generate a handoff greeting for agent ${agent || "the agent"} at ${brand}.
${slotsContext}
The agent is now taking over the call.`;

  return { systemPrompt, userPrompt };
}
