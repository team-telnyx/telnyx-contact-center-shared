/**
 * AI Models API
 * GET - List available Telnyx AI models
 */

import { NextResponse } from "next/server";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

// OpenAI models available via Telnyx pass-through (not listed in /ai/models)
const OPENAI_MODELS = [
  { id: "openai/gpt-4o", organization: "openai", parameters: "~200B", context_length: 128000, tier: "premium" },
  { id: "openai/gpt-4o-mini", organization: "openai", parameters: "~8B", context_length: 128000, tier: "premium" },
  { id: "openai/gpt-4-turbo", organization: "openai", parameters: "~200B", context_length: 128000, tier: "premium" },
  { id: "openai/gpt-4", organization: "openai", parameters: "~200B", context_length: 8192, tier: "premium" },
  { id: "openai/gpt-3.5-turbo", organization: "openai", parameters: "~20B", context_length: 16385, tier: "premium" },
  { id: "openai/o1", organization: "openai", parameters: "~200B", context_length: 200000, tier: "premium" },
  { id: "openai/o1-mini", organization: "openai", parameters: "~100B", context_length: 128000, tier: "premium" },
  { id: "openai/o1-preview", organization: "openai", parameters: "~200B", context_length: 128000, tier: "premium" },
  { id: "openai/o3-mini", organization: "openai", parameters: "~100B", context_length: 200000, tier: "premium" },
];

// Anthropic models available via Telnyx pass-through
const ANTHROPIC_MODELS = [
  { id: "anthropic/claude-3-5-sonnet-20241022", organization: "anthropic", parameters: "~70B", context_length: 200000, tier: "premium" },
  { id: "anthropic/claude-3-5-haiku-20241022", organization: "anthropic", parameters: "~20B", context_length: 200000, tier: "premium" },
  { id: "anthropic/claude-3-opus-20240229", organization: "anthropic", parameters: "~137B", context_length: 200000, tier: "premium" },
  { id: "anthropic/claude-3-sonnet-20240229", organization: "anthropic", parameters: "~70B", context_length: 200000, tier: "premium" },
  { id: "anthropic/claude-3-haiku-20240307", organization: "anthropic", parameters: "~20B", context_length: 200000, tier: "premium" },
];

export async function GET() {
  try {
    const response = await fetch(`${TELNYX_API_BASE}/ai/models`, {
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[AI Models] API error:", response.status, errorText);
      return NextResponse.json(
        { error: "Failed to fetch models" },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Filter to only text-generation models suitable for chat
    const telnyxModels = (data.data || [])
      .filter((model) => 
        model.task === "text-generation" && 
        model.context_length >= 4000 // Need reasonable context for workflows
      )
      .map((model) => ({
        id: model.id,
        name: model.id,
        organization: model.organization,
        parameters: model.parameters_str,
        context_length: model.context_length,
        tier: model.tier,
      }));

    // Combine with OpenAI and Anthropic models (pass-through)
    const allModels = [
      ...OPENAI_MODELS.map(m => ({ ...m, name: m.id })),
      ...ANTHROPIC_MODELS.map(m => ({ ...m, name: m.id })),
      ...telnyxModels,
    ].sort((a, b) => {
      // Sort by tier (premium first, then small -> medium -> large) then by name
      const tierOrder = { premium: 0, small: 1, medium: 2, large: 3 };
      const tierDiff = (tierOrder[a.tier] || 99) - (tierOrder[b.tier] || 99);
      if (tierDiff !== 0) return tierDiff;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({
      ok: true,
      models: allModels,
    });
  } catch (error) {
    console.error("[AI Models] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch models" },
      { status: 500 }
    );
  }
}
