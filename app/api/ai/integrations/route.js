import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

function noStore(body, init = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

async function telnyxFetch(path, init = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("Missing TELNYX_API_KEY");
  }

  const res = await fetch(buildTelnyxV2Url(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
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
    throw new Error(`Telnyx API error: ${res.status} ${text}`);
  }

  return data;
}

export async function GET() {
  try {
    const integrationsPromise = telnyxFetch("/ai/integrations");
    const connectionsPromise = telnyxFetch("/ai/integrations/connections").catch(
      () => null
    );

    const integrationsResponse = await integrationsPromise;
    const connectionsResponse = await connectionsPromise;

    return noStore({
      ok: true,
      integrations: Array.isArray(integrationsResponse?.data)
        ? integrationsResponse.data
        : [],
      connections: Array.isArray(connectionsResponse?.data)
        ? connectionsResponse.data
        : [],
    });
  } catch (err) {
    return noStore(
      { ok: false, error: err?.message || String(err) },
      { status: err?.message === "Missing TELNYX_API_KEY" ? 500 : 502 }
    );
  }
}
