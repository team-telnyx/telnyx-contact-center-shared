import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { buildTelnyxV2Url } from "@/lib/telnyx";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
async function listBuckets() {
  if (!process.env.TELNYX_API_KEY) return NextResponse.json({ ok: false, error: "Connect your Telnyx account to load knowledge sources." }, { status: 503, headers });
  try {
    const response = await fetch(buildTelnyxV2Url("/ai/embeddings/buckets"), {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => null);
    const buckets = body?.data?.buckets ?? body?.buckets;
    if (!response.ok || !Array.isArray(buckets)) throw new Error("Bucket catalog unavailable");
    return NextResponse.json({ ok: true, data: { buckets } }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: "Knowledge sources could not be loaded from Telnyx. Please try again." }, { status: 502, headers });
  }
}
export const GET = withPermission("ai_assistants:read", listBuckets, { route: "/api/storage/embeddings/buckets" });
