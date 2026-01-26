import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

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
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];

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
    const payload = { ...payloadRaw };
    if (payload.greetings && !payload.greeting) {
      payload.greeting = payload.greetings;
      delete payload.greetings;
    }

    // Validate transcription - deepgram/flux requires 'en' language, not 'auto'
    if (
      payload.transcription &&
      payload.transcription.model === "deepgram/flux"
    ) {
      payload.transcription.language = "en";
    }

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
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
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

