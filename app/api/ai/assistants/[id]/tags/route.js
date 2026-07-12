import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { platformApiLogger } from "@/lib/runtime-logging.mjs";

export const dynamic = "force-dynamic";

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return null;
  return apiKey;
}

export async function GET(_request, context) {
  try {
    const apiKey = getApiKey();
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
        { ok: false, error: "Missing assistant id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}/tags`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    const text = await res.text();
    if (!res.ok) {
      platformApiLogger.warn("assistant_tags_fetch_failed", {
        assistantId: id,
        status: res.status,
        detail: text.slice(0, 200),
      });
      // 404 means no tags exist yet — return empty array gracefully
      if (res.status === 404) {
        return NextResponse.json(
          { ok: true, tags: [] },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: res.status >= 500 ? 502 : res.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { data: [] };
    }
    const rawTags = data?.data || data?.tags || data || [];
    // Normalize: Telnyx may return [{tag:"name",...}] objects or plain strings
    const tags = Array.isArray(rawTags)
      ? rawTags.map((t) => (typeof t === "string" ? t : t?.tag || String(t))).filter(Boolean)
      : [];
    return NextResponse.json(
      { ok: true, tags },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(request, context) {
  try {
    const apiKey = getApiKey();
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
        { ok: false, error: "Missing assistant id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const body = await request.json().catch(() => ({}));
    // Telnyx API expects { tag: "tagname" } (singular) — one tag at a time
    // Accept either { tag: "..." } or { tags: [...] } from the client
    const tagsToAdd = body.tags
      ? Array.isArray(body.tags) ? body.tags : [body.tags]
      : body.tag ? [body.tag] : [];

    if (tagsToAdd.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing tag" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Add tags one by one (Telnyx API: POST /tags with { tag: "name" })
    const results = [];
    for (const tagName of tagsToAdd) {
      const res = await fetch(
        buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}/tags`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tag: tagName }),
        }
      );
      const text = await res.text();
      if (!res.ok) {
        return NextResponse.json(
          { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
          { status: 502, headers: { "Cache-Control": "no-store" } }
        );
      }
      try { results.push(JSON.parse(text)); } catch { results.push({}); }
    }

    return NextResponse.json(
      { ok: true, result: results },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function DELETE(request, context) {
  try {
    const apiKey = getApiKey();
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
        { ok: false, error: "Missing assistant id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { searchParams } = new URL(request.url);
    const tag = searchParams.get("tag");
    if (!tag) {
      return NextResponse.json(
        { ok: false, error: "Missing tag query param" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(
        `/ai/assistants/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`
      ),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
