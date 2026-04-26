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
