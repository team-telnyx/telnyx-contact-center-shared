/**
 * AI Models API
 * GET - List available Telnyx AI models
 */

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export async function GET() {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const response = await fetch(buildTelnyxV2Url("/ai/models"), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${response.status} ${errorText}` },
        { status: 502 }
      );
    }

    const data = await response.json();

    // Filter to text-generation models (note: some have "text-generation", others "text generation")
    const models = Array.isArray(data?.data) ? data.data.map((model) => ({
      id: model?.id || "",
      name: model?.name || model?.id || "",
      recommended_for_assistants: model?.recommended_for_assistants === true,
      raw: model || null,
    })).filter((model) => model.id) : [];

    return NextResponse.json({
      ok: true,
      models,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch models" },
      { status: 500 }
    );
  }
}
