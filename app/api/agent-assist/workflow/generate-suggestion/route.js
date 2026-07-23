/**
 * Agent Assist Workflow - Generate Suggestion API
 * POST - Generate dynamic suggestions using LLM
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, suggestionsLogger } from "@/lib/agent-assist/logging.mjs";
import { isReadBackItem, buildReadBackSuggestion, orderedSlotsFromMap, formatSlotValue, earliestReadBackItemId } from "@/lib/agent-assist/readback.mjs";
import { resolveFastSuggestionTemplate } from "@/lib/agent-assist/suggestion-templates.mjs";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// Global brand/company name for greetings, from app_settings.brand_name.
// Returns undefined when unset so the greeting templates fall back to "the company".
async function getConfiguredBrandName(pool) {
  try {
    const { rows: [row] } = await pool.query(
      `SELECT brand_name FROM app_settings WHERE id = 'default' LIMIT 1`
    );
    const name = row?.brand_name;
    return (typeof name === "string" && name.trim()) ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

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
      slotName,
      slotOptions,
      suggestionTemplate,
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

    // Resolve the brand for greetings ("Thanks for calling <brand>"). The client
    // passes brandName from the (currently unpopulated) session, so fall back to
    // the global app_settings.brand_name. When neither is set the templates use
    // "the company".
    const effectiveBrandName = (typeof brandName === "string" && brandName.trim())
      ? brandName.trim()
      : await getConfiguredBrandName(pool);

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

    // Special case: final read-back / "confirm all information" item. Read back
    // every collected slot so the agent can confirm the whole intake at once.
    // Bypasses the two-sentence truncation the generic generator applies. Only
    // fires when slots have actually been collected (otherwise falls through to
    // the normal single-line suggestion).
    //
    // Guard against reading back twice: some workflows split read-back and
    // confirmation into adjacent items (e.g. "Read back transport details" then
    // "Confirm all information is correct"). Only the EARLIEST read-back-matching
    // item recites the full list; a later confirm-all item falls through to the
    // normal short confirmation instead of repeating every slot.
    if (isReadBackItem({ itemType, itemLabel, itemPromptHint, itemHints })) {
      const earliest = await isEarliestReadBackItem(pool, workflowId, itemId);
      if (earliest !== false) {
        const orderedSlots = await buildOrderedFilledSlots(pool, workflowId, prefilledSlots || {});
        const readBack = buildReadBackSuggestion({ orderedSlots, rawSlots: prefilledSlots || {} });
        if (readBack) {
          return NextResponse.json({
            ok: true,
            suggestion: readBack,
            model: "template",
            isReadBack: true,
          });
        }
      }
    }

    const deterministicSuggestion = buildDeterministicSuggestion({
      itemType,
      itemLabel,
      itemPromptHint,
      itemHints,
      agentName,
      brandName: effectiveBrandName,
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

    // Fast templates for standard collect questions (GMR slot map, SAY: hints,
    // or generic phrasing). Prefer this over an LLM round-trip so the right
    // panel can appear in milliseconds after the target item is selected.
    const fastTemplate = resolveFastSuggestionTemplate({
      itemType,
      itemLabel,
      slotName: slotName || conversationContext?.targetSlotName || null,
      suggestionTemplate,
      itemPromptHint,
      itemHints,
      targetMode,
      agentName,
      brandName: effectiveBrandName,
      prefilledSlots,
      allowGenericSlot: true,
    });
    if (fastTemplate) {
      return NextResponse.json({
        ok: true,
        suggestion: fastTemplate,
        model: "template",
      });
    }

    // Build prompt for suggestion generation
    const systemPrompt = buildSuggestionSystemPrompt({
      itemType,
      agentName,
      brandName: effectiveBrandName,
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
      const providerErrorSummary = await response.text();
      suggestionsLogger.error("generate_suggestion", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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
        brandName: effectiveBrandName,
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
    suggestionsLogger.error("generate_suggestion", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
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
- For an opening greeting or "how can I help" item, thank the caller for calling ${brand} and ask how you can help (e.g. "Hi, thanks for calling ${brand}. How can I help you today?"). Do NOT lead with the agent's name and never say "the company". Only introduce the agent by name for an explicit "introduce yourself" item.
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

/**
 * Is this the EARLIEST read-back-matching item in the workflow (by stage, then
 * item order)? Used so only the first read-back item recites the full list and
 * an adjacent confirm-all follow-up does not repeat it.
 *   - true  → this item is the (or the only) read-back item → read back.
 *   - false → an earlier read-back item exists → skip the full read-back.
 *   - null  → unknown (no workflowId/itemId, or the workflow can't be read) →
 *             caller keeps the default read-back behavior.
 */
async function isEarliestReadBackItem(pool, workflowId, itemId) {
  if (!workflowId || !itemId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.type, i.label, i.prompt_hint, i.hints
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
        WHERE s.workflow_id = $1
        ORDER BY s.order_index, i.order_index`,
      [workflowId]
    );
    const earliestId = earliestReadBackItemId(rows);
    if (!earliestId) return null;
    return earliestId === itemId;
  } catch {
    return null;
  }
}

/**
 * Build the ordered [{ label, value }] list for the final read-back: collected
 * slots in workflow order (stage, then item), labelled with each slot item's
 * human label. Falls back to the prefilledSlots map (humanized keys) when the
 * workflow can't be read.
 */
async function buildOrderedFilledSlots(pool, workflowId, prefilledSlots) {
  if (!workflowId) {
    return orderedSlotsFromMap(prefilledSlots);
  }
  try {
    const { rows } = await pool.query(
      `SELECT i.slot_name, i.label
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
        WHERE s.workflow_id = $1 AND i.type = 'slot' AND i.slot_name IS NOT NULL
        ORDER BY s.order_index, i.order_index`,
      [workflowId]
    );
    if (!rows || rows.length === 0) {
      return orderedSlotsFromMap(prefilledSlots);
    }
    const ordered = [];
    for (const { slot_name: slotName, label } of rows) {
      const value = prefilledSlots?.[slotName];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        ordered.push({ label: label || slotName, value: formatSlotValue(value) });
      }
    }
    return ordered;
  } catch {
    return orderedSlotsFromMap(prefilledSlots);
  }
}

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function capturedSlotValue({ itemStatus, prefilledSlots, conversationContext }) {
  // A correction candidate's newly-suggested value must win over the OLD
  // confirmed value still sitting in slots_filled — a "suggested" item is
  // deliberately NOT written to slots_filled until confirmed (so read-back
  // stays on the old value until then), so the general fallback below would
  // otherwise surface the stale value being corrected, not the new one
  // pending confirmation. Gated on is_correction (set only on the correction
  // path in analyze/route.js) so this does not affect the general case below,
  // where slots_filled can hold a MORE RECENT agent-corrected value than a
  // stale itemStatus.extracted_value — see "confirm slot suggestions prefer
  // corrected filled slot values over stale suggested captures".
  if (itemStatus?.is_correction) {
    const correctionValue = itemStatus?.extracted_value ?? itemStatus?.value;
    if (hasMeaningfulValue(correctionValue)) return correctionValue;
  }

  const slotName = conversationContext?.targetSlotName;
  const prefilledValue = slotName ? prefilledSlots?.[slotName] : null;
  if (hasMeaningfulValue(prefilledValue)) return prefilledValue;

  const statusValue = itemStatus?.extracted_value ?? itemStatus?.value;
  return hasMeaningfulValue(statusValue) ? statusValue : null;
}

// A readable noun phrase for a slot label — "the caller's last name", "the
// patient's date of birth", "the number of IV drips" — used to build a natural
// collection prompt instead of the stilted "provide your <label>". Returns null
// for a label that is already a full question (the caller asks it directly).
function slotNounPhrase(label) {
  const raw = String(label || "").trim();
  if (!raw || raw.endsWith("?")) return null;
  const phrase = raw
    .toLowerCase()
    .replace(/^patient\b(?!')/, "patient's") // "patient date of birth" -> possessive
    .replace(/\biv\b/g, "IV")
    .replace(/\bicu\b/g, "ICU")
    .replace(/\bdob\b/g, "DOB");
  return `the ${phrase}`;
}

// Deterministic collection prompt for a slot. A question-label ("Other aircraft
// currently responding?") is asked verbatim (no "provide your ...??"); otherwise
// use the noun phrase ("Could you provide the caller's last name?").
function phraseSlotCollection(label) {
  const raw = String(label || "").trim();
  if (!raw) return null;
  if (raw.endsWith("?")) return raw.charAt(0).toUpperCase() + raw.slice(1);
  return `Could you provide ${slotNounPhrase(label)}?`;
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
    return `Before I ${blockedItem.label.toLowerCase()}, could you provide ${slotNounPhrase(label) || `the ${labelLower}`}?`;
  }

  // Caller flagged that an already-completed slot needs correcting (see
  // findCorrectionTargetSlot in suggestion-target-resolver.mjs) — ask what the
  // corrected value should be, rather than re-asking the original collection
  // question or falling through to a generic read-back line.
  if (targetMode === "collect_correction") {
    const value = capturedSlotValue({ itemStatus, prefilledSlots, conversationContext });
    const noun = slotNounPhrase(label) || `the ${labelLower}`;
    return hasMeaningfulValue(value)
      ? `Sorry about that — I have ${noun} as ${value}. What should it be instead?`
      : `Sorry about that — what should ${noun} be corrected to?`;
  }

  if (conversationContext?.reason === "conversation_stage_match" && itemType === "slot") {
    return phraseSlotCollection(label);
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

  // Opening greeting / "how can I help" item: brand-forward — "Thanks for calling
  // <brand>" — never "this is <agent> with the company". Require greeting/opening
  // WORDING on a NON-slot item so a first item that is a slot or ordinary question
  // (e.g. "Customer full name") is NOT hijacked into a greeting. Explicit
  // "introduce yourself as ..." items are handled above and keep the agent name.
  const looksLikeOpeningGreeting =
    itemType !== "slot" &&
    (/\b(greet|greeting|welcome|say hello|hello)\b/i.test(label) ||
      /how (can|may|to)\s+(i\s+)?(help|assist)|assist (you|today)|help you today|how may i be of/i.test(`${label} ${promptHint}`));
  if (looksLikeOpeningGreeting) {
    // Drop the "the company" placeholder — a brandless "thanks for calling" reads
    // cleanly until a real brand is configured (app_settings.brand_name).
    const brandPhrase = brand && brand !== "the company" ? `calling ${brand}` : "calling";
    return `Hi, thanks for ${brandPhrase}. How can I help you today?`;
  }

  if (allowGeneric && itemType === "slot") {
    return phraseSlotCollection(label);
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
