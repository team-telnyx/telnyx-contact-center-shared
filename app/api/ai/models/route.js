/**
 * AI Models API
 * GET - List available Telnyx AI models
 */

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { isQualityInferenceModel } from "@/lib/quality/models.mjs";
import { resolveOperationModel } from "@/lib/ai-operations/runtime.mjs";

import { withPermission } from "@/lib/authz/guard";
async function GET_handler(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const response = await fetch(buildTelnyxV2Url("/ai/openai/models"), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${response.status} ${errorText}` },
        { status: 502 }
      );
    }

    const data = await response.json();

    const quality = new URL(request.url).searchParams.get("capability") === "quality-evaluation";
    const catalog = Array.isArray(data?.data) ? data.data : [];
    const supported = quality ? catalog.filter(isQualityInferenceModel) : catalog;
    const models = supported.map((model) => ({
      id: model?.id || "",
      name: model?.name || model?.id || "",
      recommended_for_assistants: model?.recommended_for_assistants === true,
      is_vision_supported: typeof model?.is_vision_supported === "boolean" ? model.is_vision_supported : null,
      raw: model || null,
    })).filter((model) => model.id);

    // The model a scorecard without its own model uses: Admin → AI Copilot
    // "Quality evaluation", else the platform default, else
    // TELNYX_AI_DEFAULT_MODEL. null when none is configured (no model in code).
    const defaultModel = quality
      ? await resolveOperationModel("quality-evaluation").then((resolved) => resolved.model || null).catch(() => null)
      : null;

    return NextResponse.json({
      ok: true,
      models,
      ...(quality ? { default_model: defaultModel } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch models" },
      { status: 500 }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("ai_models:read", GET_handler, { route: "/api/ai/models" });
