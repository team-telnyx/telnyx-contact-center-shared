import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

async function telnyxJson(path, { apiKey, method = "GET", body } = {}) {
  const res = await fetch(buildTelnyxV2Url(path), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const error = new Error(`Telnyx API error: ${res.status} ${text}`);
    error.status = res.status;
    error.response = data;
    throw error;
  }

  return data?.data || data;
}

function assistantHasTool(assistant, toolId) {
  return Array.isArray(assistant?.tools)
    ? assistant.tools.some((tool) => String(tool?.tool_id || "") === String(toolId))
    : false;
}

export async function POST(request, context) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { params } = await context;
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Missing tool id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const payload = await request.json().catch(() => ({}));
    const assistantIds = Array.isArray(payload.assistantIds)
      ? payload.assistantIds.map(String).filter(Boolean)
      : [];

    if (assistantIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Select at least one assistant" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const tool = await telnyxJson(`/ai/tools/${encodeURIComponent(id)}`, { apiKey });
    const toolId = String(tool?.id || id);
    const results = [];

    for (const assistantId of assistantIds) {
      const assistant = await telnyxJson(
        `/ai/assistants/${encodeURIComponent(assistantId)}`,
        { apiKey }
      );

      if (assistantHasTool(assistant, toolId)) {
        results.push({ assistantId, updated: false, skipped: "already_attached" });
        continue;
      }

      const updated = await telnyxJson(
        `/ai/assistants/${encodeURIComponent(assistantId)}/tools/${encodeURIComponent(toolId)}`,
        {
          apiKey,
          method: "PUT",
        }
      );
      results.push({ assistantId, updated: true, assistant: updated });
    }

    return NextResponse.json(
      {
        ok: true,
        toolId,
        updated: results.filter((result) => result.updated).length,
        skipped: results.filter((result) => !result.updated).length,
        results,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: err?.status || 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
