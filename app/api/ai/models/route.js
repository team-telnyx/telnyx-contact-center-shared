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
    
    // Filter to only text-generation models suitable for chat
    const chatModels = (data.data || [])
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
      }))
      .sort((a, b) => {
        // Sort by tier (small -> medium -> large) then by name
        const tierOrder = { small: 1, medium: 2, large: 3 };
        const tierDiff = (tierOrder[a.tier] || 0) - (tierOrder[b.tier] || 0);
        if (tierDiff !== 0) return tierDiff;
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
