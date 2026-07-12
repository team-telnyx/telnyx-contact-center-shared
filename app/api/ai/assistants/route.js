import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { normalizeAssistantPayload } from "@/lib/ai/assistant-payload.mjs";
import { telnyxErrorDetail } from "@/lib/telnyx-error.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "10", 10))
    );
    const qName = (searchParams.get("name") || "").trim().toLowerCase();
    const qId = (searchParams.get("id") || "").trim().toLowerCase();
    const qModel = (searchParams.get("model") || "").trim().toLowerCase();
    const onlyWorkflowAssistants = searchParams.get("onlyWorkflowAssistants") === "true";

    const res = await fetch(buildTelnyxV2Url("/ai/assistants"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    let list = Array.isArray(data?.data) ? data.data : [];

    // Filter by workflows if requested
    if (onlyWorkflowAssistants) {
      const pool = getPostgresPool();
      if (pool) {
        try {
          const { rows } = await pool.query(
            `SELECT DISTINCT ai_assistant_id
             FROM aa_workflows
             WHERE ai_assistant_id IS NOT NULL AND ai_assistant_id != ''`
          );
          const workflowAssistantIds = new Set(
            rows.map((r) => r.ai_assistant_id).filter(Boolean)
          );
          list = list.filter((a) => workflowAssistantIds.has(a.id));
        } catch (err) {
          platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
        }
      }
    }

    const filtered = list.filter((a) => {
      const name = String(a?.name || "").toLowerCase();
      const id = String(a?.id || "").toLowerCase();
      const model = String(
        a?.model || a?.llm_model || a?.llm || ""
      ).toLowerCase();
      if (qName && !name.includes(qName)) return false;
      if (qId && !id.includes(qId)) return false;
      if (qModel && !model.includes(qModel)) return false;
      return true;
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const items = filtered.slice(start, end);

    return NextResponse.json(
      { ok: true, page, pageSize, total, items },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const payloadRaw = await request.json().catch(() => ({}));
    const payload = normalizeAssistantPayload(payloadRaw);

    const res = await fetch(buildTelnyxV2Url("/ai/assistants"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
      cache: "no-store",
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { data: null, raw: text };
    }

    return NextResponse.json(
      { ok: true, assistant: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
