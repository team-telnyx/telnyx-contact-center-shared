import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getAuthenticatedUser } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

function parseMaybeJsonObject(value) {
  if (typeof value !== "string") return value;
  const str = value.trim();
  if (!(str.startsWith("{") || str.startsWith("["))) return value;
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object") return parsed;
    return value;
  } catch {
    return value;
  }
}

function deepParseJsonStrings(input) {
  if (Array.isArray(input)) {
    return input.map((v) => deepParseJsonStrings(v));
  }
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const maybe = parseMaybeJsonObject(v);
      if (maybe && typeof maybe === "object") {
        out[k] = deepParseJsonStrings(maybe);
      } else if (Array.isArray(maybe)) {
        out[k] = deepParseJsonStrings(maybe);
      } else if (v && typeof v === "object") {
        out[k] = deepParseJsonStrings(v);
      } else {
        out[k] = maybe;
      }
    }
    return out;
  }
  return input;
}

export async function GET(request, context) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

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
        { ok: false, error: "Missing conversation id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { searchParams } = new URL(request.url);
    const upstream = new URL(
      buildTelnyxV2Url(
        `/ai/conversations/${encodeURIComponent(id)}/webhook-logs`
      )
    );
    if (!searchParams.has("page[number]"))
      upstream.searchParams.set("page[number]", "1");
    if (!searchParams.has("page[size]"))
      upstream.searchParams.set("page[size]", "1");
    if (!searchParams.has("sort"))
      upstream.searchParams.set("sort", "-created_at");
    searchParams.forEach((value, key) => {
      upstream.searchParams.set(key, value);
    });

    const res = await fetch(upstream.toString(), {
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
    const transformed = deepParseJsonStrings(data);
    return NextResponse.json(
      { ok: true, data: transformed },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

