export const dynamic = "force-dynamic";

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
      itemPromptHint,
      itemHints,
      itemType,
      slotOptions,
      workflowId,
      agentName,
      brandName,
      previousConversation,
      isAiAssisted,
      isFirstItem,
      prefilledSlots,
      targetMode,
      conversationContext,
      blockedItem,
      itemStatus,
    } = body;

    if (!itemLabel) {
      return NextResponse.json(
        { error: "itemLabel is required" },
        { status: 400 }
      );
    }

    // Get workflow to get LLM model
    let llmModel = "openai/gpt-4o"; // Default
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
      return NextResponse.json({
        ok: true,
        suggestion: buildDefaultHandoffGreeting({
          agentName,
          prefilledSlots: prefilledSlots || {},
        }),
        model: "template",
        isHandoffGreeting: true,
      });
    }

    const deterministicSuggestion = buildDeterministicSuggestion({
      itemType,
      itemLabel,
      itemPromptHint,
      itemHints,
      agentName,
      brandName,
      targetMode,
      conversationContext,
      blockedItem,
      prefilledSlots,
      itemStatus,
    });
    if (deterministicSuggestion) {
      return NextResponse.json({
        ok: true,
        suggestion: deterministicSuggestion,
        model: "template",
      });
    }

    // Build prompt for suggestion generation
    const systemPrompt = buildSuggestionSystemPrompt({
      itemType,
      agentName,
      brandName,
      isAiAssisted,
      targetMode,
    });

    const userPrompt = buildSuggestionUserPrompt({
      itemType,
      itemLabel,
      itemDescription,
      itemHints,
      slotOptions,
      previousConversation,
      prefilledSlots,
      targetMode,
      conversationContext,
      blockedItem,
      prefilledSlots,
      itemStatus,
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
        temperature: 0.4,
        max_tokens: 90,
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

    suggestion = cleanSuggestedResponse(suggestion, { agentName });
    if (!suggestion) {
      const fallbackSuggestion = buildDeterministicSuggestion({
        itemType,
        itemLabel,
        itemPromptHint,
        itemHints,
        agentName,
        brandName,
        targetMode,
        conversationContext,
        blockedItem,
        prefilledSlots,
        itemStatus,
        allowGeneric: true,
      });
      if (fallbackSuggestion) {
        return NextResponse.json({
          ok: true,
          suggestion: fallbackSuggestion,
          model: "template",
        });
      }
      return NextResponse.json(
        { error: "No usable suggestion generated" },
        { status: 500 }
      );
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
function buildSuggestionSystemPrompt({ itemType, agentName, brandName, isAiAssisted, targetMode }) {
  const agentIdentity = agentName || "an agent";
  const brand = brandName || "the company";

  return `You are an expert contact center assistant helping ${agentIdentity} at ${brand}.
Your task is to generate the exact words the agent should say next to the customer.

Hard rules:
- Return only the spoken line. No summary, no explanation, no labels, no markdown, no bullet points.
- Write in first person as the agent, ready to say aloud.
- Keep it concise: one short paragraph, preferably one sentence, maximum two sentences.
- Do not describe what the agent should do. Say the actual words.
- Do not include internal workflow names, item ids, analysis, or recap sections.
- If the item is a greeting or introduction, introduce the agent by name when known.
- If the call was transferred from an AI assistant, acknowledge that briefly only when it helps the first handoff.
- Do not jump back to the first pending workflow item when the conversation clearly moved to another workflow stage.
- Follow the provided target mode exactly: collect the selected slot, confirm a low-confidence slot, or collect a prerequisite for a blocked item.

Match the item type:
   - **action**: Suggest what the agent should say while performing the action
   - **question**: Generate a clear question to ask the customer
   - **topic**: Suggest how to introduce or discuss this topic
   - **slot**: Generate a polite question to collect the specific information

Context:
- Agent: ${agentIdentity}
- Brand: ${brand}
- Item type: ${itemType || "workflow item"}
- Target mode: ${targetMode || "continue_workflow"}
- AI-assisted call: ${isAiAssisted ? "yes" : "no"}`;
}

/**
 * Build user prompt for suggestion generation
 */
function buildSuggestionUserPrompt({
  itemType,
  itemLabel,
  itemDescription,
  slotOptions,
  previousConversation,
  prefilledSlots,
  targetMode,
  conversationContext,
  blockedItem,
  itemStatus,
}) {
  let prompt = `Generate only the exact sentence(s) the agent should say next.

Workflow item:
- Type: ${itemType || "unknown"}
- Label: ${itemLabel}`;

  if (targetMode) {
    prompt += `\nTarget mode: ${targetMode}`;
  }

  if (conversationContext?.activeStageName) {
    prompt += `\nDetected conversation stage: ${conversationContext.activeStageName}`;
  }

  if (conversationContext?.reason) {
    prompt += `\nTarget selection reason: ${conversationContext.reason}`;
  }

  if (targetMode === "confirm_slot") {
    const value = capturedSlotValue({ itemStatus, prefilledSlots, conversationContext });
    prompt += `\nInstruction: Ask the agent to confirm the captured slot value with the customer before treating it as completed.`;
    if (value) prompt += ` Captured value: ${value}.`;
  }

  if (targetMode === "collect_prerequisite" && blockedItem?.label) {
    prompt += `\nBlocked later item: ${blockedItem.label}`;
    prompt += `\nInstruction: Do not suggest the blocked item yet. Ask only for the missing prerequisite represented by the selected workflow item.`;
  }

  if (itemDescription) {
    prompt += `\n**Context**: ${itemDescription}`;
  }

  if (slotOptions && slotOptions.length > 0) {
    prompt += `\nOptions the customer can choose from: ${slotOptions.join(", ")}`;
  }

  const filledSlots = Object.entries(prefilledSlots || {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== ""
  );
  if (filledSlots.length > 0) {
    prompt += `\nAlready collected customer data: ${filledSlots
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")}`;
  }

  if (previousConversation && previousConversation.length > 0) {
    const recentMessages = previousConversation.slice(-5);
    prompt += `\n\nRecent conversation context:\n`;
    prompt += recentMessages
      .map((msg) => `${msg.speaker}: "${msg.text}"`)
      .join("\n");
  }

  prompt += `\n\nReturn the spoken response only.`;
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

  const systemPrompt = `Generate the exact words a human contact center agent should say when taking over from an AI assistant.
Return only the spoken line. No labels, no summary, no markdown.
Write in first person as the agent. Keep it to one concise, natural sentence or two short sentences.
Use this style when the agent name is known: "Hello, I'm John. I can see you've been redirected from our AI assistant, which already collected some information. Would you like us to continue from there?"`;

  const userPrompt = `Generate a handoff greeting for agent ${agent || "the agent"} at ${brand}.
${slotsContext}
The agent is now taking over the call.`;

  return { systemPrompt, userPrompt };
}

function buildDefaultHandoffGreeting({ agentName, prefilledSlots }) {
  const finalAgentName = agentName && agentName !== "the agent" ? agentName : null;
  const intro = finalAgentName
    ? `Hello, I'm ${finalAgentName}.`
    : "Hello, I'm your support agent.";
  const hasPrefilledSlots = Object.values(prefilledSlots || {}).some(
    (value) => value !== null && value !== undefined && value !== ""
  );
  const context = hasPrefilledSlots
    ? "I can see you've been redirected from our AI assistant, which already collected some information."
    : "I can see you've been redirected from our AI assistant.";

  return `${intro} ${context} Would you like us to continue from there?`;
}

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function capturedSlotValue({ itemStatus, prefilledSlots, conversationContext }) {
  const slotName = conversationContext?.targetSlotName;
  const prefilledValue = slotName ? prefilledSlots?.[slotName] : null;
  if (hasMeaningfulValue(prefilledValue)) return prefilledValue;

  const statusValue = itemStatus?.extracted_value ?? itemStatus?.value;
  return hasMeaningfulValue(statusValue) ? statusValue : null;
}

function buildDeterministicSuggestion({
  itemType,
  itemLabel,
  itemPromptHint,
  itemHints,
  agentName,
  brandName,
  targetMode,
  conversationContext,
  blockedItem,
  prefilledSlots,
  itemStatus,
  allowGeneric = false,
}) {
  const label = String(itemLabel || "").trim();
  const promptHint = [
    itemPromptHint,
    ...(Array.isArray(itemHints) ? itemHints : []),
  ].filter(Boolean).join("\n");
  const labelLower = label.toLowerCase();
  const finalAgentName = agentName && agentName !== "the agent" ? agentName : null;
  const brand = brandName || extractBrandFromIntro(label) || extractBrandFromOpening(promptHint) || "the company";

  if (targetMode === "confirm_slot") {
    const value = capturedSlotValue({ itemStatus, prefilledSlots, conversationContext });
    if (hasMeaningfulValue(value)) {
      return `I captured ${labelLower} as ${value}. Could you please confirm that this is correct?`;
    }
    return `I captured ${labelLower}. Could you please confirm that this is correct?`;
  }

  if (targetMode === "collect_prerequisite" && blockedItem?.label) {
    return `Before I ${blockedItem.label.toLowerCase()}, could you please provide your ${labelLower}?`;
  }

  if (conversationContext?.reason === "conversation_stage_match" && itemType === "slot") {
    return `Could you please provide your ${labelLower}?`;
  }

  const introduceMatch = label.match(/introduce (?:yourself|your self)(?: as)?\s+(.+?)$/i);
  if (introduceMatch) {
    const identity = buildHumanIntroIdentity({
      labelIdentity: introduceMatch[1],
      promptHint,
      agentName: finalAgentName,
      brand,
    });
    return `Hello, I'm ${identity}. I'll be helping you today.`;
  }

  const introduceAsMatch = label.match(/(?:^|\b)(?:i am|i'm|my name is)\s+(.+?)$/i);
  if (introduceAsMatch) {
    const identity = buildHumanIntroIdentity({
      labelIdentity: introduceAsMatch[1],
      promptHint,
      agentName: finalAgentName,
      brand,
    });
    return `Hello, I'm ${identity}. I'll be helping you today.`;
  }

  if (/\b(greet|greeting|welcome|say hello|introduce)\b/i.test(label)) {
    if (finalAgentName) {
      return `Hello, I'm ${finalAgentName}. I'll be helping you today.`;
    }
    return `Hello, I'm calling from ${brand}. I'll be helping you today.`;
  }

  if (allowGeneric && itemType === "slot") {
    return `Could you please provide your ${labelLower}?`;
  }

  return null;
}

function buildHumanIntroIdentity({ labelIdentity, promptHint, agentName, brand }) {
  const rawIdentity = String(labelIdentity || "").trim().replace(/[.!?]+$/, "");
  const introBrand = extractBrandFromIntro(rawIdentity) || extractBrandFromOpening(promptHint) || brand;
  if (agentName && introBrand) return `${agentName} from ${introBrand}`;
  if (agentName) return agentName;
  return rawIdentity || `your support agent from ${introBrand || "the company"}`;
}

function extractBrandFromIntro(text) {
  return String(text || "").match(/\bfrom\s+(.+)$/i)?.[1]?.trim() || null;
}

function extractBrandFromOpening(text) {
  const opening = extractQuotedOpening(text) || text;
  return String(opening || "").match(/\b(?:at|from)\s+([A-Z][\p{L}\p{N}& '-]+)/u)?.[1]?.trim() || null;
}

function extractQuotedOpening(text) {
  const match = String(text || "").match(/["“]([^"”]+)["”]/);
  return match?.[1]?.trim() || null;
}

function cleanSuggestedResponse(rawSuggestion, { agentName } = {}) {
  let suggestion = String(rawSuggestion || "")
    .replace(/^```(?:json|text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  suggestion = suggestion
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(summary|suggested response|response|script|agent should say|agent|assistant|note|explanation)\s*:/i.test(line))
    .join(" ");

  suggestion = suggestion
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (looksLikeReasoningResponse(suggestion)) {
    return "";
  }

  for (let i = 0; i < 3; i++) {
    suggestion = suggestion
      .replace(/^["'\u2018\u2019\u201c\u201d\u201e\u00ab\u00bb]|["'\u2018\u2019\u201c\u201d\u201e\u00bb\u00ab]$/g, "")
      .trim();
  }

  const finalAgentName = agentName && agentName !== "the agent" ? agentName : null;
  if (finalAgentName) {
    suggestion = suggestion
      .replace(/\[Your Name\]/gi, finalAgentName)
      .replace(/\[Agent Name\]/gi, finalAgentName)
      .replace(/\[Agent's Name\]/gi, finalAgentName)
      .replace(/\[Name\]/gi, finalAgentName)
      .replace(/\{Your Name\}/gi, finalAgentName)
      .replace(/\{Agent Name\}/gi, finalAgentName);
  }

  const sentences = suggestion.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  if (sentences.length > 2) {
    suggestion = sentences.slice(0, 2).join(" ").trim();
  }

  const words = suggestion.split(/\s+/).filter(Boolean);
  if (words.length > 55) {
    suggestion = `${words.slice(0, 55).join(" ").replace(/[,.!?;:]+$/, "")}.`;
  }

  return suggestion.trim();
}

function looksLikeReasoningResponse(suggestion) {
  const lower = String(suggestion || "").toLowerCase();
  return (
    lower.startsWith("the user wants") ||
    lower.startsWith("we need") ||
    lower.startsWith("i need") ||
    lower.includes("key details:") ||
    lower.includes("from context") ||
    lower.includes("this is a contradiction") ||
    lower.includes("workflow item says") ||
    lower.includes("the exact words the agent should say")
  );
}
