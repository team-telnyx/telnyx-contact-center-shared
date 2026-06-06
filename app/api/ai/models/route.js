export const dynamic = "force-dynamic";

/**
 * AI Models API
 * GET - List available Telnyx AI models
 */

import { NextResponse } from "next/server";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

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
    
    // Filter to text-generation models (note: some have "text-generation", others "text generation")
    const chatModels = (data.data || [])
      .filter((model) => {
        const task = (model.task || "").toLowerCase().replace("-", " ");
        return task.includes("text generation") && model.context_length >= 4000;
      })
      .map((model) => ({
        id: model.id,
        name: model.id,
        organization: model.organization,
        parameters: model.parameters_str || "unknown",
        context_length: model.context_length,
        tier: model.tier,
        recommended: model.recommended_for_assistants || false,
      }))
      .sort((a, b) => {
        // Sort: recommended first, then by organization (openai, anthropic, google first), then by name
        if (a.recommended !== b.recommended) return b.recommended - a.recommended;
        const orgOrder = { openai: 0, anthropic: 1, google: 2, groq: 3, "xai-org": 4 };
        const orgDiff = (orgOrder[a.organization] ?? 99) - (orgOrder[b.organization] ?? 99);
        if (orgDiff !== 0) return orgDiff;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({
      ok: true,
      models: chatModels,
    });
  } catch (error) {
    console.error("[AI Models] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch models" },
      { status: 500 }
    );
  }
}
